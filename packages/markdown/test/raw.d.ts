/** Vite loads shared fixture bytes as strings; no testkit runtime enters the isomorphic package. */
declare module '*.md?raw' {
  const source: string;
  export default source;
}
