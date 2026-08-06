import {CONSTRUCTOR_ARGUMENTS_SYMBOL_IDENTIFIER} from "../../constant.js";
import type {TS} from "../../../type/type.js";
import type {BeforeVisitorOptions} from "../before-visitor-options.js";
import type {VisitorContext} from "../../visitor-context.js";
import {getModifierLikes, pickServiceOrImplementationName} from "../util.js";

export function visitClassLikeDeclaration(options: BeforeVisitorOptions<TS.ClassLikeDeclaration>): TS.VisitResult<TS.Node> {
	const {node, childContinuation, continuation, context} = options;
	const {typescript, factory} = context;
	const constructorDeclaration = node.members.find(typescript.isConstructorDeclaration);

	// If there are no constructor declaration for the ClassLikeDeclaration, there's nothing to do
	if (constructorDeclaration == null) {
		return childContinuation(node);
	}

	const updatedClassMembers: readonly TS.ClassElement[] = [
		...(node.members.map(continuation) as TS.ClassElement[]),
		factory.createGetAccessorDeclaration(
			[factory.createModifier(typescript.SyntaxKind.StaticKeyword)],
			factory.createComputedPropertyName(factory.createIdentifier(`Symbol.for("${CONSTRUCTOR_ARGUMENTS_SYMBOL_IDENTIFIER}")`)),
			[],
			undefined,
			factory.createBlock([factory.createReturnStatement(getConstructorArgumentsAsArrayLiteral(constructorDeclaration.parameters, context))])
		)
	];

	const modifierLikes = getModifierLikes(node);

	if (typescript.isClassDeclaration(node)) {
		return factory.updateClassDeclaration(node, modifierLikes, node.name, node.typeParameters, node.heritageClauses, updatedClassMembers);
	} else {
		return factory.updateClassExpression(node, modifierLikes, node.name, node.typeParameters, node.heritageClauses, updatedClassMembers);
	}
}

/**
 * Takes ConstructorParams for the given NodeArray of ParameterDeclarations
 */
function getConstructorArgumentsAsArrayLiteral(parameters: TS.NodeArray<TS.ParameterDeclaration>, context: VisitorContext): TS.ArrayLiteralExpression {
	const {factory} = context;
	const constructorParams: TS.Expression[] = [];

	for (let i = 0; i < parameters.length; i++) {
		const parameter = parameters[i]!;
		// If the parameter has no type, there's nothing to extract
		if (parameter.type == null) {
			constructorParams[i] = factory.createIdentifier("undefined");
		} else {
			constructorParams[i] = createConstructorArgument(parameter.type, context);
		}
	}

	return factory.createArrayLiteralExpression(constructorParams);
}

interface FactorySignature {
	parameters: string[];
	returns: string;
}

function createConstructorArgument(type: TS.TypeNode, context: VisitorContext): TS.Expression {
	const factorySignature = getFactorySignature(type, context);
	if (factorySignature == null) return createServiceDependency(pickServiceOrImplementationName(type, context), context);

	return context.factory.createObjectLiteralExpression([
		context.factory.createPropertyAssignment("kind", context.factory.createStringLiteral("factory")),
		context.factory.createPropertyAssignment(
			"parameters",
			context.factory.createArrayLiteralExpression(factorySignature.parameters.map(identifier => createServiceDependency(identifier, context)))
		),
		context.factory.createPropertyAssignment("returns", createServiceDependency(factorySignature.returns, context))
	]);
}

function createServiceDependency(identifier: string, context: VisitorContext): TS.ObjectLiteralExpression {
	return context.factory.createObjectLiteralExpression([
		context.factory.createPropertyAssignment("kind", context.factory.createStringLiteral("service")),
		context.factory.createPropertyAssignment("identifier", context.factory.createNoSubstitutionTemplateLiteral(identifier))
	]);
}

function getFactorySignature(type: TS.TypeNode, context: VisitorContext): FactorySignature | undefined {
	const syntacticSignature = getSyntacticFactorySignature(type, type, context);
	if (syntacticSignature != null) return syntacticSignature;

	const alias = getLocalTypeAlias(type, context);
	if (alias != null) return getSyntacticFactorySignature(alias.type, type, context);
	if (!("typeChecker" in context)) return undefined;

	return getCheckedFactorySignature(type, context);
}

function getSyntacticFactorySignature(type: TS.TypeNode, source: TS.TypeNode, context: VisitorContext): FactorySignature | undefined {
	if (context.typescript.isFunctionTypeNode(type)) return createFactorySignature(type, source, context);
	if (!context.typescript.isTypeLiteralNode(type)) return undefined;

	const signatures = type.members.filter(context.typescript.isCallSignatureDeclaration);
	if (signatures.length === 0) return undefined;
	if (signatures.length > 1) return unsupportedFactory(source, "overloads");

	return createFactorySignature(signatures[0]!, source, context);
}

function createFactorySignature(signature: TS.SignatureDeclaration, source: TS.TypeNode, context: VisitorContext): FactorySignature {
	assertSupportedParameters(signature.parameters, source);
	if (signature.parameters.some(parameter => parameter.type == null) || signature.type == null) return unsupportedFactory(source, "untyped parameters or returns");

	const parameters = signature.parameters.map(parameter => pickServiceOrImplementationName(parameter.type!, context));
	assertDistinctParameterTypes(parameters, source);

	return {
		parameters,
		returns: pickServiceOrImplementationName(signature.type, context)
	};
}

function getLocalTypeAlias(type: TS.TypeNode, context: VisitorContext): TS.TypeAliasDeclaration | undefined {
	if (!context.typescript.isTypeReferenceNode(type) || !context.typescript.isIdentifier(type.typeName)) return undefined;
	const aliasName = type.typeName.text;

	return type
		.getSourceFile()
		.statements.find((statement): statement is TS.TypeAliasDeclaration => context.typescript.isTypeAliasDeclaration(statement) && statement.name.text === aliasName);
}

function getCheckedFactorySignature(type: TS.TypeNode, context: Extract<VisitorContext, {typeChecker: TS.TypeChecker}>): FactorySignature | undefined {
	const signatures = context.typeChecker.getTypeAtLocation(type).getCallSignatures();
	if (signatures.length === 0) return undefined;
	if (signatures.length > 1) return unsupportedFactory(type, "overloads");

	const signature = signatures[0]!;
	const parameters = signature.parameters.map(parameter => getSymbolTypeName(parameter, type, context));
	assertCheckedParameters(signature.parameters, type);
	assertDistinctParameterTypes(parameters, type);

	return {parameters, returns: normalizeTypeName(context.typeChecker.typeToString(context.typeChecker.getReturnTypeOfSignature(signature)))};
}

function assertSupportedParameters(parameters: TS.NodeArray<TS.ParameterDeclaration>, source: TS.TypeNode): void {
	if (parameters.some(parameter => parameter.questionToken != null || parameter.initializer != null)) unsupportedFactory(source, "optional parameters");
	if (parameters.some(parameter => parameter.dotDotDotToken != null)) unsupportedFactory(source, "rest parameters");
}

function assertCheckedParameters(parameters: readonly TS.Symbol[], source: TS.TypeNode): void {
	const declarations = parameters.flatMap(parameter => parameter.declarations ?? []);
	if (declarations.some(declaration => "questionToken" in declaration && declaration.questionToken != null)) unsupportedFactory(source, "optional parameters");
	if (declarations.some(declaration => "dotDotDotToken" in declaration && declaration.dotDotDotToken != null)) unsupportedFactory(source, "rest parameters");
}

function assertDistinctParameterTypes(parameters: string[], source: TS.TypeNode): void {
	if (new Set(parameters).size !== parameters.length) unsupportedFactory(source, "duplicate parameter types");
}

function getSymbolTypeName(symbol: TS.Symbol, location: TS.Node, context: Extract<VisitorContext, {typeChecker: TS.TypeChecker}>): string {
	const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0] ?? location;
	const type = context.typeChecker.getTypeOfSymbolAtLocation(symbol, declaration);

	return normalizeTypeName(context.typeChecker.typeToString(type));
}

function normalizeTypeName(name: string): string {
	const genericStart = name.indexOf("<");
	return genericStart < 0 ? name.trim() : name.slice(0, genericStart).trim();
}

function unsupportedFactory(type: TS.TypeNode, feature: string): never {
	throw new TypeError(`Automatic factory '${type.getText().trim()}' is not supported: ${feature} are not implemented.`);
}
