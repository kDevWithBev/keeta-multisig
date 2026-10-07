import { Buffer as PolyfillBuffer } from 'buffer';

const Buffer = PolyfillBuffer;
globalThis.Buffer = PolyfillBuffer;

export { Buffer };
