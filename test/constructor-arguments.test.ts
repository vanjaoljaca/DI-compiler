import {generateCustomTransformerResult} from "./setup/setup-custom-transformer.js";
import {formatCode} from "./util/format-code.js";
import semver from "semver";
import {test} from "./util/test-runner.js";
import assert from "node:assert";

test("Can parse constructor parameters and extend with an internal static class member. #1", "*", (_, {typescript, useProgram}) => {
	const bundle = generateCustomTransformerResult(
		[
			{
				entry: true,
				fileName: "index.ts",
				text: `
				interface IFoo {}
				class Foo {
					constructor (private foo: IFoo) {}
				}
			`
			}
		],
		{typescript, useProgram}
	);
	const [file] = bundle;
	assert.deepEqual(
		formatCode(file!.text),
		formatCode(`\
			class Foo {${semver.gte(typescript.version, "4.3.0") ? `\n\t\tfoo;` : ""}
				constructor(foo) {
					this.foo = foo;
				}
				static get [Symbol.for("___CTOR_ARGS___")]() { return [{ kind: "service", identifier: \`IFoo\` }]; }
			}
			`)
	);
});

test("Can parse constructor parameters and extend with an internal static class member. #2", "*", (_, {typescript, useProgram}) => {
	const bundle = generateCustomTransformerResult(
		[
			{
				entry: true,
				fileName: "index.ts",
				text: `
				interface IFoo {}
				class Foo {
					constructor (private foo: IFoo = {}, private bar) {}
				}
			`
			}
		],
		{typescript, useProgram}
	);
	const [file] = bundle;
	assert.deepEqual(
		formatCode(file!.text),
		formatCode(`\
			class Foo {${semver.gte(typescript.version, "4.3.0") ? `\n\t\tfoo;\n\t\tbar;` : ""}
				constructor(foo = {}, bar) {
					this.foo = foo;
					this.bar = bar;
				}
				static get [Symbol.for("___CTOR_ARGS___")]() { return [{ kind: "service", identifier: \`IFoo\` }, undefined]; }
			}
			`)
	);
});

test("When declaring service dependencies via constructor arguments, their type arguments should be irrelevant. #1", "*", (_, {typescript, useProgram}) => {
	const bundle = generateCustomTransformerResult(
		[
			{
				entry: true,
				fileName: "index.ts",
				text: `
          interface IFoo<T> {}
          class Foo {
            constructor (private foo: IFoo<string>) {}
          }
			`
			}
		],
		{typescript, useProgram}
	);
	const [file] = bundle;

	assert.deepEqual(
		formatCode(file!.text),
		formatCode(`\
      class Foo {${semver.gte(typescript.version, "4.3.0") ? `\n\t\tfoo;` : ""}
          constructor(foo) {
              this.foo = foo;
          }
          static get [Symbol.for("___CTOR_ARGS___")]() { return [{ kind: "service", identifier: \`IFoo\` }]; }
      }
			`)
	);
});

test("Can describe an inline automatic factory dependency. #1", "*", (_, {typescript, useProgram}) => {
	const bundle = generateCustomTransformerResult(
		[
			{
				entry: true,
				fileName: "index.ts",
				text: `
				interface IX {}
				class Consumer {
					constructor (private createX: (key: string) => IX) {}
				}
			`
			}
		],
		{typescript, useProgram}
	);
	const [file] = bundle;

	assert.deepEqual(
		formatCode(file!.text),
		formatCode(`\
			class Consumer {${semver.gte(typescript.version, "4.3.0") ? `\n\t\tcreateX;` : ""}
				constructor(createX) {
					this.createX = createX;
				}
				static get [Symbol.for("___CTOR_ARGS___")]() {
					return [{
						kind: "factory",
						parameters: [{ kind: "service", identifier: \`string\` }],
						returns: { kind: "service", identifier: \`IX\` }
					}];
				}
			}
			`)
	);
});

test("Can describe an inline automatic factory without parameters. #1", "*", (_, {typescript, useProgram}) => {
	const bundle = generateCustomTransformerResult(
		[
			{
				entry: true,
				fileName: "index.ts",
				text: `
				class X {}
				class Consumer {
					constructor (private createX: () => X) {}
				}
			`
			}
		],
		{typescript, useProgram}
	);
	const [file] = bundle;

	assert.deepEqual(
		formatCode(file!.text),
		formatCode(`\
			class X {}
			class Consumer {${semver.gte(typescript.version, "4.3.0") ? `\n\t\tcreateX;` : ""}
				constructor(createX) {
					this.createX = createX;
				}
				static get [Symbol.for("___CTOR_ARGS___")]() {
					return [{ kind: "factory", parameters: [], returns: { kind: "service", identifier: \`X\` } }];
				}
			}
			`)
	);
});

test("Can describe a named automatic factory dependency. #1", "*", (_, {typescript, useProgram}) => {
	const bundle = generateCustomTransformerResult(
		[
			{
				entry: true,
				fileName: "index.ts",
				text: `
				interface IX {}
				type CreateX = (key: string) => IX;
				class Consumer {
					constructor (private createX: CreateX) {}
				}
			`
			}
		],
		{typescript, useProgram}
	);
	const [file] = bundle;

	assert.deepEqual(
		formatCode(file!.text),
		formatCode(`\
			class Consumer {${semver.gte(typescript.version, "4.3.0") ? `\n\t\tcreateX;` : ""}
				constructor(createX) {
					this.createX = createX;
				}
				static get [Symbol.for("___CTOR_ARGS___")]() {
					return [{
						kind: "factory",
						parameters: [{ kind: "service", identifier: \`string\` }],
						returns: { kind: "service", identifier: \`IX\` }
					}];
				}
			}
			`)
	);
});

test("Rejects optional automatic factory parameters. #1", "*", (_, {typescript, useProgram}) => {
	assert.throws(
		() => transformFactory(`(key?: string) => IX`, typescript, useProgram),
		(error: Error) => error instanceof TypeError && error.message.includes("optional parameters are not implemented")
	);
});

test("Rejects rest automatic factory parameters. #1", "*", (_, {typescript, useProgram}) => {
	assert.throws(
		() => transformFactory(`(...keys: string[]) => IX`, typescript, useProgram),
		(error: Error) => error instanceof TypeError && error.message.includes("rest parameters are not implemented")
	);
});

test("Rejects overloaded automatic factories. #1", "*", (_, {typescript, useProgram}) => {
	assert.throws(
		() => transformFactory(`{ (key: string): IX; (key: number): IX }`, typescript, useProgram),
		(error: Error) => error instanceof TypeError && error.message.includes("overloads are not implemented")
	);
});

test("Rejects duplicate automatic factory parameter types. #1", "*", (_, {typescript, useProgram}) => {
	assert.throws(
		() => transformFactory(`(first: string, second: string) => IX`, typescript, useProgram),
		(error: Error) => error instanceof TypeError && error.message.includes("duplicate parameter types are not implemented")
	);
});

function transformFactory(factoryType: string, typescript: Parameters<typeof generateCustomTransformerResult>[1]["typescript"], useProgram: boolean): void {
	generateCustomTransformerResult(
		[
			{
				entry: true,
				fileName: "index.ts",
				text: `interface IX {} class Consumer { constructor (createX: ${factoryType}) {} }`
			}
		],
		{typescript, useProgram}
	);
}
