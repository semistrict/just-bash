/**
 * Transforms an async iterable of arbitrary string chunks into an
 * async iterable of complete lines (each ending with '\n', except
 * possibly the last one if the input doesn't end with a newline).
 */
export async function* lineStream(
  input: AsyncIterable<string>,
): AsyncGenerator<string> {
  let partial = "";

  for await (const chunk of input) {
    const data = partial + chunk;
    let start = 0;
    let nlIdx = data.indexOf("\n", start);

    while (nlIdx !== -1) {
      yield data.slice(start, nlIdx + 1);
      start = nlIdx + 1;
      nlIdx = data.indexOf("\n", start);
    }

    partial = data.slice(start);
  }

  if (partial) {
    yield partial;
  }
}
