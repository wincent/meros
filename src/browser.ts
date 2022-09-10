import type { Options, Part } from 'meros';

import type { Arrayable } from './shared';

const decoder = new TextDecoder;

async function* generate<T>(
  stream: ReadableStream<Uint8Array>,
  boundary: string,
  options?: Options,
): AsyncGenerator<Arrayable<Part<T, string>>> {
  const reader = stream.getReader();
  const is_eager = !options || !options.multiple;

  let len_boundary = boundary.length;
  let buffer = '';
  let is_preamble = true;
  let payloads = [];

  try {
    let result: ReadableStreamReadResult<Uint8Array>;
    outer: while (!(result = await reader.read()).done) {
      const chunk = decoder.decode(result.value);
      const idx_chunk = chunk.indexOf(boundary);
      let idx_boundary = buffer.length;

      buffer += chunk;

      if (!!~idx_chunk) {
        // chunk itself had `boundary` marker
        idx_boundary += idx_chunk;
      } else {
        // search combined (boundary can be across chunks)
        idx_boundary = buffer.indexOf(boundary);
      }

      payloads = [];
      while (!!~idx_boundary) {
        const current = buffer.substring(0, idx_boundary);
        const next = buffer.substring(idx_boundary + len_boundary);

        if (is_preamble) {
          is_preamble = false;
          boundary = '\r\n' + boundary;
          len_boundary += 2;
        } else {
          const headers: Record<string, string> = {};
          const idx_headers = current.indexOf('\r\n\r\n') + 4; // 4 -> '\r\n\r\n'.length
          const arr_headers = String(buffer.slice(0, idx_headers))
            .trim()
            .split('\r\n');

          // parse headers
          let tmp;
          while (tmp = arr_headers.shift()) {
            tmp = tmp.split(': ');
            headers[tmp.shift()!.toLowerCase()] = tmp.join(': ');
          }

          const last_idx = current.lastIndexOf('\r\n', idx_headers); // 4 -> '\r\n\r\n'.length

          let body: T | string = current.substring(idx_headers, last_idx > -1 ? undefined : last_idx);
          let is_json = false;

          tmp = headers['content-type'];
          if (tmp && !!~tmp.indexOf('application/json')) {
            try {
              body = JSON.parse(body) as T;
              is_json = true;
            } catch (_) {
            }
          }

          tmp = { headers, body, json: is_json } as Part<T, string>;
          is_eager ? yield tmp : payloads.push(tmp);

          // hit a tail boundary, break
          if ('--' === next.substring(0, 2)) break outer;
        }

        buffer = next;
        idx_boundary = buffer.indexOf(boundary);
      }

      if (payloads.length) yield payloads;
    }
  } finally {
    if (payloads.length) yield payloads;
    await reader.cancel();
  }
}

export async function meros<T = object>(response: Response, options?: Options) {
  if (!response.ok || !response.body || response.bodyUsed) return response;

  const ctype = response.headers.get('content-type');
  if (!ctype || !~ctype.indexOf('multipart/mixed')) return response;

  const idx_boundary = ctype.indexOf('boundary=');

  return generate<T>(
    response.body,
    `--${!!~idx_boundary
      ? // +9 for 'boundary='.length
      ctype.substring(idx_boundary + 9).trim().replace(/['"]/g, '')
      : '-'}`,
    options,
  );
}
