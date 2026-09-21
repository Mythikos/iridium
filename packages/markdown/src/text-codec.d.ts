/**
 * The WHATWG Encoding globals `normalizeSource` uses, declared here because the package compiles
 * with `lib: ["es2024"]` alone: `TextDecoder` and `TextEncoder` exist in every runtime the package
 * targets — Node 24, the browser and the Electron renderer — but TypeScript types them only in
 * `lib.dom` and `@types/node`, and an isomorphic package may depend on neither.
 *
 * Only the members the package calls are declared. The file is an ambient declaration inside `src`,
 * so it is part of this package's compilation and of nothing else: no consumer that compiles
 * against `@types/node` ever sees a second declaration of the same names.
 */

interface IridiumTextDecoderOptions {
  readonly fatal?: boolean;
  readonly ignoreBOM?: boolean;
}

declare class TextDecoder {
  constructor(label?: string, options?: IridiumTextDecoderOptions);
  decode(input?: Uint8Array): string;
}

declare class TextEncoder {
  encode(input?: string): Uint8Array;
  encodeInto(input: string, destination: Uint8Array): { read: number; written: number };
}

/** Native in Node 24 and both supported worker hosts; used to keep parsed trees immutable. */
declare function structuredClone<T>(value: T): T;
