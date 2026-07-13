import assert from "node:assert/strict";
import test from "node:test";
import { Jimp } from "jimp";
import { resizeToPng, decodeIconDataUri } from "../dist/pkginfo/icon.js";

test("图标缩放为目标正方形 PNG", async () => {
  const src = new Jimp({ width: 30, height: 20, color: 0x112233ff });
  const out = await resizeToPng(await src.getBuffer("image/png"), 512);
  const image = await Jimp.read(out);
  assert.equal(image.bitmap.width, 512);
  assert.equal(image.bitmap.height, 512);
});

test("图标支持 216 像素目标尺寸", async () => {
  const src = new Jimp({ width: 64, height: 64, color: 0x00ff00ff });
  const out = await resizeToPng(await src.getBuffer("image/png"), 216, 216);
  const image = await Jimp.read(out);
  assert.equal(image.bitmap.width, 216);
});

test("图标 data URI 可以解码", () => {
  const bytes = decodeIconDataUri(`data:image/png;base64,${Buffer.from("hi").toString("base64")}`);
  assert.equal(bytes?.toString(), "hi");
  assert.equal(decodeIconDataUri(undefined), undefined);
});
