import assert from "node:assert/strict";
import test from "node:test";
import { birthdayExportFilename, birthdayNoteColor, birthdayWallSvg, escapeBirthdayXml, layoutBirthdayWall, wrapBirthdayText } from "../../src/birthday-wall-export.js";

const measure = (text) => Array.from(text).length * 38;

test("birthday vector export escapes text and rejects executable image URLs", () => {
  const wallName = '<script>&"寿星';
  const note = { message: '<svg onload="alert(1)">生日快乐</svg> & 爱', name: "<陌生朋友>", emojis: "🎂", color: "url(javascript:alert(1))" };
  const layout = layoutBirthdayWall([note], measure, { wallName });
  const svg = birthdayWallSvg(layout, { total: 1, participants: 1, today: 1 }, "javascript:alert(1)");
  assert.equal(escapeBirthdayXml("\u0000<&>\"'"), "&lt;&amp;&gt;&quot;&apos;");
  assert(!svg.includes("<script>")); assert(!svg.includes('<svg onload=')); assert(!svg.includes("javascript:"));
  assert(svg.includes("&lt;script&gt;&amp;&quot;")); assert(svg.includes("&lt;陌生朋友&gt;"));
  assert.match(birthdayNoteColor(note.color), /^#[0-9a-f]{6}$/i);
});

test("birthday line wrapping preserves emoji graphemes and empty paragraphs", () => {
  const lines = wrapBirthdayText("生日👨‍👩‍👧‍👦快乐\n\n第二行", measure, 100);
  assert(lines.includes("👨‍👩‍👧‍👦")); assert(lines.includes(""));
  assert.equal(lines.join(""), "生日👨‍👩‍👧‍👦快乐第二行");
});

test("birthday export retains all 1000 long blessings at 4K width", () => {
  const notes = Array.from({ length: 1_000 }, (_, index) => ({ id: String(index), message: `第${index}条：${"愿你健康平安，快乐常伴。".repeat(35)}`, name: `朋友${index}`, emojis: "🎂 ✨", color: "#FFE5E8" }));
  const layout = layoutBirthdayWall(notes, measure, { wallName: "小满" });
  assert.equal(layout.width, 4096); assert.equal(layout.cards.length, 1000); assert(layout.height > 8192);
  for (const card of layout.cards) {
    assert.equal(card.lines.join(""), card.note.message);
    assert(card.y + card.height < layout.height);
    assert(card.x >= 0 && card.x + card.width <= layout.width);
  }
  const svg = birthdayWallSvg(layout, { total: 1000, participants: 1000, today: 1000 }, null);
  assert.equal((svg.match(/rx="26" fill="#FFE5E8"/g) || []).length, 1000);
  assert(svg.includes("朋友999")); assert(svg.includes("小满的生日墙"));
  assert(svg.includes("1000 份暖心祝福"));
  assert(!svg.includes("位朋友")); assert(!svg.includes("今日新增"));
});

test("birthday long honoree name wraps without overlapping artwork or notes", () => {
  const wallName = "生日快乐平安健康万事如意".repeat(4).slice(0, 40);
  const layout = layoutBirthdayWall([{ message: "生日快乐", name: "朋友" }], measure, { wallName });
  assert.equal(layout.titleLines.join(""), `${wallName}的生日墙`);
  assert(layout.titleLines.length > 1);
  for (const line of layout.titleLines) assert(measure(line) * 138 / 38 <= 2810);
  assert(layout.descriptionY > 278 + (layout.titleLines.length - 1) * 168);
  assert(layout.cards[0].y > layout.statsY + 100);
  assert(layout.cards[0].y >= 700);
});

test("birthday download filename contains the honoree without filesystem control characters", () => {
  const filename = birthdayExportFilename('小满:/\\"<>|?*\u0000', "2026-10-22", "png");
  assert(filename.startsWith("小满")); assert(filename.endsWith("的生日墙-2026-10-22-4K.png"));
  assert(!/[\\/:*?"<>|\u0000-\u001f]/.test(filename));
  assert.equal(birthdayExportFilename("", "2026-10-22", "svg"), "生日墙-2026-10-22-完整矢量长图.svg");
});
