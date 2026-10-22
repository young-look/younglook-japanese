/**
 * FormData → multipart/form-data 的原始请求体。
 *
 * ── 为什么要有它 ──────────────────────────────────────────────────────────
 * `requestUrl`（Electron 主进程发出）的 body 只收 `string | ArrayBuffer`，
 * 收不了浏览器的 FormData —— boundary 是浏览器临时生成的，只有交给 fetch
 * 才能自动带上。上传（跟读录音、反馈截图）又必须是 multipart，于是自己
 * 按 RFC 7578 拼一遍，让这两处也能走 `requestUrl`。
 */

export interface MultipartBody {
  body: ArrayBuffer;
  /** 含 boundary 的完整 Content-Type（boundary 是本函数生成的）。 */
  contentType: string;
}

const CRLF = "\r\n";

/** 把 FromData 编成 multipart 请求体（异步：文件部分要读成字节）。 */
export async function formDataToMultipart(form: FormData): Promise<MultipartBody> {
  const boundary = randomBoundary();
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const pushText = (text: string): void => {
    chunks.push(encoder.encode(text));
  };

  const entries: Array<[string, FormDataEntryValue]> = [];
  form.forEach((value, key) => {
    entries.push([key, value]);
  });

  for (const [name, value] of entries) {
    pushText(`--${boundary}${CRLF}`);
    if (typeof value === "string") {
      pushText(`Content-Disposition: form-data; name="${quote(name)}"${CRLF}${CRLF}`);
      pushText(value);
      pushText(CRLF);
      continue;
    }
    const filename = value.name || "file.bin";
    pushText(`Content-Disposition: form-data; name="${quote(name)}"; filename="${quote(filename)}"${CRLF}`);
    pushText(`Content-Type: ${value.type || "application/octet-stream"}${CRLF}${CRLF}`);
    chunks.push(new Uint8Array(await value.arrayBuffer()));
    pushText(CRLF);
  }
  pushText(`--${boundary}--${CRLF}`);

  // .buffer 的静态类型是 ArrayBufferLike（可能是 SharedArrayBuffer），requestUrl
  // 只收 ArrayBuffer —— 拷一份到显式构造的 ArrayBuffer，顺便不用断言。
  const merged = concat(chunks);
  const out = new ArrayBuffer(merged.byteLength);
  new Uint8Array(out).set(merged);

  return {
    body: out,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** 头部字段值里的引号/换行必须转义，否则服务端拆不开这一段。 */
function quote(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/[\r\n]/gu, " ");
}

function randomBoundary(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `----YoungLookFormBoundary${hex}`;
}
