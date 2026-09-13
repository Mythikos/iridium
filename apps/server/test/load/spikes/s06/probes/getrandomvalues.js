/**
 * Spike S6's smallest measurement, and the one with the largest consequence: how much entropy does
 * k6 2.2.0's `crypto.getRandomValues` actually write?
 *
 * It needs no bundle and no server:
 *
 *   K6_BINARY_PROVISIONING=false k6 run probes/getrandomvalues.js
 *
 * `lib0/random.uint32()` is `getRandomValues(new Uint32Array(1))[0]` and yjs's
 * `generateNewClientId` *is* `lib0/random.uint32`, so whatever this prints is the range every
 * `Y.Doc.clientID` created inside k6 falls into.
 */
export const options = { vus: 1, iterations: 1 };

export default function () {
  const u8 = new Uint8Array(8);
  crypto.getRandomValues(u8);
  const u16 = new Uint16Array(4);
  crypto.getRandomValues(u16);
  const u32 = new Uint32Array(4);
  crypto.getRandomValues(u32);

  console.info(`Uint8Array(8)            -> ${JSON.stringify(Array.from(u8))}`);
  console.info(`Uint16Array(4)           -> ${JSON.stringify(Array.from(u16))}`);
  console.info(`Uint32Array(4)           -> ${JSON.stringify(Array.from(u32))}`);
  console.info(
    `Uint32Array(4) raw bytes -> ${JSON.stringify(Array.from(new Uint8Array(u32.buffer)))}`,
  );

  let max = 0;
  let distinct = new Set();
  for (let i = 0; i < 10_000; i += 1) {
    const draw = new Uint32Array(1);
    crypto.getRandomValues(draw);
    if (draw[0] > max) max = draw[0];
    distinct.add(draw[0]);
  }
  console.info(
    `10000 draws of getRandomValues(new Uint32Array(1)): max=${String(max)} distinct=${String(distinct.size)} (a 32-bit generator would reach 4294967295)`,
  );
}
