const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';
const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
const INK = "#42394e";
const PAPER = "#fffaf3";
const COLORS = ["#fff0b8", "#fce0e6", "#dff1e5", "#e5e3fa", "#dceefb", "#ffdfc8"];

export function escapeBirthdayXml(value) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
}

export function birthdayNoteColor(value, index = 0) {
  return /^#[\da-f]{6}$/i.test(String(value || "")) ? value : COLORS[index % COLORS.length];
}

function graphemes(value) {
  return typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter("zh-CN", { granularity: "grapheme" }).segment(value)].map((part) => part.segment)
    : Array.from(value);
}

export function wrapBirthdayText(text, measure, width) {
  const lines = [];
  for (const paragraph of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    let line = "";
    for (const char of graphemes(paragraph)) {
      if (line && measure(line + char) > width) { lines.push(line); line = char; }
      else line += char;
    }
    lines.push(line);
  }
  return lines;
}

export function layoutBirthdayWall(notes, measure, { wallName = "" } = {}) {
  const width = 4096;
  const columns = 4;
  const margin = 136;
  const gap = 48;
  const cardWidth = (width - margin * 2 - gap * (columns - 1)) / columns;
  const title = wallName ? `${wallName}的生日墙` : "生日墙";
  const titleLines = wrapBirthdayText(title, (value) => measure(value) * 138 / 38, 2810);
  const titleBottom = 278 + (titleLines.length - 1) * 168;
  const descriptionY = titleBottom + 124;
  const statsY = titleBottom + 237;
  const top = Math.max(700, statsY + 185);
  const bottoms = Array(columns).fill(top);
  const cards = notes.map((note, index) => {
    const lines = wrapBirthdayText(note.message, measure, cardWidth - 112);
    const names = wrapBirthdayText(note.name || "一位祝福你的朋友", measure, cardWidth - 112);
    const height = 176 + lines.length * 58 + names.length * 44 + 90;
    const column = bottoms.indexOf(Math.min(...bottoms));
    const card = { note, index, x: margin + column * (cardWidth + gap), y: bottoms[column], width: cardWidth, height, lines, names };
    bottoms[column] += height + gap;
    return card;
  });
  return { width, height: Math.max(2200, Math.max(...bottoms) + 180), cards, titleLines, descriptionY, statsY, top };
}

function imageDataUrl(value) {
  return /^data:image\/(png|jpeg|webp);base64,[A-Za-z\d+/=]+$/.test(String(value || "")) ? value : null;
}

function emojiText(note) {
  return Array.isArray(note.emojis) ? note.emojis.join(" ") : String(note.emojis || "🎂 ✨ 💛");
}

export function birthdayWallSvg(layout, stats, artwork) {
  const text = (value, x, y, size, extra = "") => `<text x="${x}" y="${y}" font-size="${size}" ${extra}>${escapeBirthdayXml(value)}</text>`;
  const art = imageDataUrl(artwork);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">
<rect width="100%" height="100%" fill="${PAPER}"/>
<g fill="${INK}" font-family="${escapeBirthdayXml(FONT)}">
${art ? `<image x="3100" y="112" width="760" height="480" preserveAspectRatio="xMidYMid slice" href="${art}"/>` : '<circle cx="3610" cy="300" r="176" fill="#fce0e6"/><circle cx="3750" cy="422" r="92" fill="#e5e3fa"/>'}
${layout.titleLines.map((line, index) => text(line, 152, 278 + index * 168, 138, 'font-weight="700"')).join("")}
${text("愿每一份心意，都被好好珍藏。", 158, layout.descriptionY, 50, 'fill="#75697e"')}
${text(`${stats.total ?? layout.cards.length} 份祝福   ·   ${stats.participants ?? 0} 位朋友   ·   今日新增 ${stats.today ?? 0} 份`, 158, layout.statsY, 38, 'fill="#807389"')}
${layout.cards.map(({ note, index, x, y, width, height, lines, names }) => `<g>
<rect x="${x + 5}" y="${y + 15}" width="${width}" height="${height}" rx="26" fill="#45334b" opacity=".05"/>
<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="26" fill="${birthdayNoteColor(note.color, index)}"/>
<rect x="${x + width / 2 - 72}" y="${y - 15}" width="144" height="35" rx="4" fill="#fffdf6" opacity=".7"/>
${text(emojiText(note), x + 56, y + 96, 48, `font-family="${escapeBirthdayXml(EMOJI_FONT)}"`)}
${lines.map((line, lineIndex) => text(line, x + 56, y + 178 + lineIndex * 58, 38, 'xml:space="preserve"')).join("")}
<path d="M${x + 56} ${y + height - names.length * 44 - 66} H${x + width - 56}" stroke="#42394e" opacity=".12"/>
${names.map((name, nameIndex) => text(name, x + 56, y + height - 53 - (names.length - 1 - nameIndex) * 44, 32, 'fill="#66556f" xml:space="preserve"')).join("")}
</g>`).join("")}
${text("此刻的祝福，永远的纪念。", layout.width / 2, layout.height - 70, 32, 'text-anchor="middle" fill="#918397"')}
</g></svg>`;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.style.display = "none";
  document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function roundedRect(ctx, x, y, width, height, radius, fill) {
  ctx.beginPath(); ctx.roundRect(x, y, width, height, radius); ctx.fillStyle = fill; ctx.fill();
}

async function loadImage(data) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("生日画面读取失败，请重新生成画面后再导出"));
    image.src = data;
  });
}

export function birthdayExportFilename(wallName, date, format) {
  const name = Array.from(String(wallName || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim()).slice(0, 40).join("");
  return `${name ? `${name}的` : ""}生日墙-${date}-${format === "svg" ? "完整矢量长图.svg" : "4K.png"}`;
}

export async function exportBirthdayWall({ notes = [], stats = {}, artwork = null, wallName = "" }) {
  await document.fonts?.ready;
  const measureCanvas = document.createElement("canvas");
  const measureContext = measureCanvas.getContext("2d");
  if (!measureContext) throw new Error("当前浏览器无法创建图片，请换一个浏览器后重试");
  measureContext.font = `38px ${FONT}`;
  const layout = layoutBirthdayWall(notes, (value) => measureContext.measureText(value).width, { wallName });
  const date = new Date().toLocaleDateString("sv-SE");
  const svg = () => {
    download(new Blob([birthdayWallSvg(layout, stats, artwork)], { type: "image/svg+xml;charset=utf-8" }), birthdayExportFilename(wallName, date, "svg"));
    return { format: "svg", width: layout.width, height: layout.height, count: notes.length };
  };
  // Keep every message at its intended type size. Large walls remain one scalable image.
  if (layout.height > 8192 || layout.width * layout.height > 32_000_000) return svg();
  const canvas = document.createElement("canvas");
  canvas.width = layout.width; canvas.height = layout.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return svg();
  try {
    ctx.fillStyle = PAPER; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const art = imageDataUrl(artwork);
    if (art) {
      const image = await loadImage(art);
      ctx.save(); ctx.beginPath(); ctx.roundRect(3100, 112, 760, 480, 40); ctx.clip();
      const scale = Math.max(760 / image.naturalWidth, 480 / image.naturalHeight);
      ctx.drawImage(image, 3100 + (760 - image.naturalWidth * scale) / 2, 112 + (480 - image.naturalHeight * scale) / 2, image.naturalWidth * scale, image.naturalHeight * scale);
      ctx.restore();
    } else {
      ctx.fillStyle = "#fce0e6"; ctx.beginPath(); ctx.arc(3610, 300, 176, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#e5e3fa"; ctx.beginPath(); ctx.arc(3750, 422, 92, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = INK; ctx.font = `700 138px ${FONT}`;
    layout.titleLines.forEach((line, index) => ctx.fillText(line, 152, 278 + index * 168));
    ctx.fillStyle = "#75697e"; ctx.font = `50px ${FONT}`; ctx.fillText("愿每一份心意，都被好好珍藏。", 158, layout.descriptionY);
    ctx.fillStyle = "#807389"; ctx.font = `38px ${FONT}`;
    ctx.fillText(`${stats.total ?? notes.length} 份祝福   ·   ${stats.participants ?? 0} 位朋友   ·   今日新增 ${stats.today ?? 0} 份`, 158, layout.statsY);
    for (const { note, index, x, y, width, height, lines, names } of layout.cards) {
      roundedRect(ctx, x + 5, y + 15, width, height, 26, "#45334b0d");
      roundedRect(ctx, x, y, width, height, 26, birthdayNoteColor(note.color, index));
      roundedRect(ctx, x + width / 2 - 72, y - 15, 144, 35, 4, "#fffdf6b3");
      ctx.fillStyle = INK; ctx.font = `48px ${EMOJI_FONT}`; ctx.fillText(emojiText(note), x + 56, y + 96);
      ctx.font = `38px ${FONT}`;
      lines.forEach((line, lineIndex) => ctx.fillText(line, x + 56, y + 178 + lineIndex * 58));
      ctx.strokeStyle = "#42394e1f"; ctx.lineWidth = 1; ctx.beginPath();
      ctx.moveTo(x + 56, y + height - names.length * 44 - 66); ctx.lineTo(x + width - 56, y + height - names.length * 44 - 66); ctx.stroke();
      ctx.font = `32px ${FONT}`; ctx.fillStyle = "#66556f";
      names.forEach((name, nameIndex) => ctx.fillText(name, x + 56, y + height - 53 - (names.length - 1 - nameIndex) * 44));
    }
    ctx.fillStyle = "#918397"; ctx.font = `32px ${FONT}`; ctx.textAlign = "center";
    ctx.fillText("此刻的祝福，永远的纪念。", layout.width / 2, layout.height - 70);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return svg();
    download(blob, birthdayExportFilename(wallName, date, "png"));
    return { format: "png", width: layout.width, height: layout.height, count: notes.length };
  } catch (error) {
    if (/生日画面/.test(error.message)) throw error;
    return svg();
  } finally {
    canvas.width = 1; canvas.height = 1;
  }
}
