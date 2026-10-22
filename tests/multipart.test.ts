import { describe, expect, it } from "vitest";
import { formDataToMultipart } from "../src/services/multipart";

/**
 * 自己拼 multipart（2026-10-21）。
 *
 * 为什么钉它：`requestUrl` 收不了浏览器的 FormData，上传（跟读录音、反馈截图）
 * 必须自己拼。**拼错了服务端不会报错，只会拿到空字段** —— 那种"上传成功但
 * 里面是空的"最难查，所以这里把字节直接摊开看。
 */
describe("formDataToMultipart", () => {
  it("文本字段：逐个进 Content-Disposition，正文原样保留", async () => {
    const form = new FormData();
    form.append("kind", "bug");
    form.append("content", "按了没反应");

    const { body, contentType } = await formDataToMultipart(form);
    const boundary = boundaryOf(contentType);
    const text = new TextDecoder().decode(body);

    expect(contentType).toBe(`multipart/form-data; boundary=${boundary}`);
    expect(text).toContain(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nbug\r\n`);
    expect(text).toContain(`name="content"\r\n\r\n按了没反应\r\n`);
    // 收尾的分隔符，少一个服务端就认为这段没传完
    expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });

  it("文件字段：带 filename 与 Content-Type，字节一个不差", async () => {
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x52, 0x49]);
    const file = new File([bytes], "read-aloud.wav", { type: "audio/wav" });
    const form = new FormData();
    form.append("audio", file);

    const { body } = await formDataToMultipart(form);
    const text = new TextDecoder().decode(body);

    expect(text).toContain(`name="audio"; filename="read-aloud.wav"\r\n`);
    expect(text).toContain("Content-Type: audio/wav\r\n\r\n");
    // 字节必须紧跟在文件头的空行后面，且一个不差 —— 当文本转一圈就会丢 0x00/0xff
    const marker = "Content-Type: audio/wav\r\n\r\n";
    const start = byteIndexOf(body, marker) + marker.length;
    expect(Array.from(new Uint8Array(body).slice(start, start + 8))).toEqual([
      0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x52, 0x49,
    ]);
  });

  it("文件名带引号/换行：转义掉，不许把这一段拆坏", async () => {
    const file = new File([new Uint8Array([1])], 'we"ird\rname.wav', { type: "audio/wav" });
    const form = new FormData();
    form.append("audio", file);

    const { body } = await formDataToMultipart(form);
    const text = new TextDecoder().decode(body);
    expect(text).toContain(`filename="we\\"ird name.wav"`);
  });

  it("混装：真拿 undici 的 multipart 解析器拆一遍，服务端能认", async () => {
    const form = new FormData();
    form.append("ja", "それでいいの");
    form.append("words", JSON.stringify([{ surface: "それ" }]));
    form.append("audio", new File([new Uint8Array([1, 2, 3, 4])], "a.wav", { type: "audio/wav" }));

    const { body, contentType } = await formDataToMultipart(form);
    // 站在服务端那一侧：收到这么一串字节，能不能原样拆回表单
    const parsed = await new Request("https://younglook.cc/upload", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    }).formData();

    expect(parsed.get("ja")).toBe("それでいいの");
    expect(parsed.get("words")).toBe(JSON.stringify([{ surface: "それ" }]));
    const audio = parsed.get("audio");
    expect(audio).toBeInstanceOf(File);
    expect((audio as File).name).toBe("a.wav");
    expect(Array.from(new Uint8Array(await (audio as File).arrayBuffer()))).toEqual([1, 2, 3, 4]);
  });

  it("空表单：只有一个收尾分隔符（仍是合法 multipart）", async () => {
    const { body, contentType } = await formDataToMultipart(new FormData());
    expect(new TextDecoder().decode(body)).toBe(`--${boundaryOf(contentType)}--\r\n`);
  });
});

/** 找一段 ASCII 标记在请求体里的字节位置（用来定位文件正文）。 */
function byteIndexOf(body: ArrayBuffer, marker: string): number {
  const bytes = new Uint8Array(body);
  const needle = new TextEncoder().encode(marker);
  for (let i = 0; i + needle.length <= bytes.length; i += 1) {
    let hit = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (bytes[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
}

function boundaryOf(contentType: string): string {
  const match = /boundary=(.+)$/u.exec(contentType);
  if (!match) throw new Error(`没有 boundary：${contentType}`);
  return match[1];
}
