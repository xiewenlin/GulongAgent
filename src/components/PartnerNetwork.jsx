import { ArrowsIn, ArrowsOut, ArrowSquareOut, Handshake, ImageSquare, Path, Pause, Play, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

const industryColors = {
  technology: "#43d8c3",
  finance: "#e7b95c",
  education: "#7ea8ef",
  healthcare: "#6fd49b",
  commerce: "#ee8c72",
  industry: "#93aaa8",
  culture: "#bd91ea",
  public: "#7db8d7",
  services: "#c8ae73",
  other: "#9eb2b0",
};

const DEFAULT_VIEW = { yaw: 0.18, pitch: -0.12, zoom: 1 };
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const ambientSphere = Array.from({ length: 58 }, (_, index) => {
  const y = 1 - (index / 57) * 2;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = index * GOLDEN_ANGLE;
  return { x: Math.cos(theta) * radius, y: y * 0.78, z: Math.sin(theta) * radius };
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function projectPoint(point, view) {
  const cosYaw = Math.cos(view.yaw);
  const sinYaw = Math.sin(view.yaw);
  const xYaw = point.x * cosYaw - point.z * sinYaw;
  const zYaw = point.x * sinYaw + point.z * cosYaw;
  const cosPitch = Math.cos(view.pitch);
  const sinPitch = Math.sin(view.pitch);
  const yPitch = point.y * cosPitch - zYaw * sinPitch;
  const zPitch = point.y * sinPitch + zYaw * cosPitch;
  const perspective = 2.7 / (2.7 - zPitch * 0.72);
  const depth = clamp((zPitch + 1.15) / 2.3, 0, 1);
  return {
    x: 50 + xYaw * 38 * perspective * view.zoom,
    y: 51 + yPitch * 34 * perspective * view.zoom,
    depth,
    perspective,
  };
}

export function PartnerNetwork({ partners }) {
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const [view, setView] = useState(DEFAULT_VIEW);
  const [paused, setPaused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [industry, setIndustry] = useState("all");
  const [preview, setPreview] = useState(null);
  const [fullScreen, setFullScreen] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 1, height: 1 });

  const industries = useMemo(() => {
    const map = new Map();
    for (const partner of partners) map.set(partner.industryKey || "other", partner.industryName || "其他行业");
    return [...map.entries()];
  }, [partners]);

  const visible = useMemo(() => industry === "all" ? partners : partners.filter((partner) => (partner.industryKey || "other") === industry), [industry, partners]);

  const layout = useMemo(() => {
    const groupKeys = [...new Set(visible.map((partner) => partner.industryKey || "other"))];
    const groupPositions = new Map(groupKeys.map((key, groupIndex) => [key, visible.filter((partner) => (partner.industryKey || "other") === key).map((partner) => partner.id)]));
    return visible.map((partner, index) => {
      const key = partner.industryKey || "other";
      const groupIndex = Math.max(0, groupKeys.indexOf(key));
      const groupCount = Math.max(1, groupKeys.length);
      const groupMembers = groupPositions.get(key) || [];
      const memberIndex = Math.max(0, groupMembers.indexOf(partner.id));
      const groupCenter = groupCount === 1 ? 0 : -0.66 + (groupIndex / (groupCount - 1)) * 1.32;
      const localOffset = (memberIndex - (groupMembers.length - 1) / 2) * 0.26;
      const y = clamp(groupCenter + localOffset, -0.88, 0.88);
      const radius = Math.sqrt(Math.max(0.14, 1 - y * y));
      const theta = index * GOLDEN_ANGLE + groupIndex * 0.7;
      const projected = projectPoint({ x: Math.cos(theta) * radius, y, z: Math.sin(theta) * radius }, view);
      return {
        ...partner,
        ...projected,
        size: 68 + projected.depth * 68,
        color: industryColors[key] || industryColors.other,
      };
    });
  }, [view, visible]);

  const ambientLayout = useMemo(() => ambientSphere.map((point, index) => ({ ...projectPoint(point, view), index })), [view]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const update = () => {
      const rect = stage.getBoundingClientRect();
      setStageSize({ width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [fullScreen]);

  useEffect(() => {
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (paused || dragging || reduceMotion) return undefined;
    let frame;
    let previous = performance.now();
    const animate = (now) => {
      if (now - previous > 38) {
        const delta = Math.min(2.4, (now - previous) / 38);
        setView((current) => ({ ...current, yaw: current.yaw + 0.0045 * delta }));
        previous = now;
      }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [dragging, paused]);

  useEffect(() => {
    if (!fullScreen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event) => event.key === "Escape" && setFullScreen(false);
    window.addEventListener("keydown", closeOnEscape);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", closeOnEscape); };
  }, [fullScreen]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { width, height } = stageSize;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const points = ambientLayout.map((point) => ({ ...point, px: point.x / 100 * width, py: point.y / 100 * height }));
    for (let index = 0; index < points.length; index += 1) {
      const source = points[index];
      for (let candidate = index + 1; candidate < points.length; candidate += 1) {
        const target = points[candidate];
        const distance = Math.hypot(source.px - target.px, source.py - target.py);
        if (distance > Math.min(145, width * 0.15) || Math.abs(source.depth - target.depth) > 0.28) continue;
        context.beginPath();
        context.moveTo(source.px, source.py);
        context.lineTo(target.px, target.py);
        context.strokeStyle = `rgba(53, 171, 205, ${0.045 + Math.min(source.depth, target.depth) * 0.15})`;
        context.lineWidth = 0.7 + Math.min(source.depth, target.depth) * 0.9;
        context.stroke();
      }
      context.beginPath();
      context.arc(source.px, source.py, 1.2 + source.depth * 2.4, 0, Math.PI * 2);
      context.fillStyle = `rgba(73, 205, 212, ${0.14 + source.depth * 0.48})`;
      context.fill();
    }

    for (let index = 0; index < layout.length; index += 1) {
      const source = layout[index];
      const sourceX = source.x / 100 * width;
      const sourceY = source.y / 100 * height;
      context.beginPath();
      context.moveTo(width / 2, height / 2);
      context.lineTo(sourceX, sourceY);
      context.strokeStyle = `${source.color}${Math.round(48 + source.depth * 70).toString(16).padStart(2, "0")}`;
      context.lineWidth = 0.9 + source.depth * 1.4;
      context.stroke();
      for (let candidate = index + 1; candidate < layout.length; candidate += 1) {
        const target = layout[candidate];
        if (target.industryKey !== source.industryKey || candidate - index > 5) continue;
        context.beginPath();
        context.moveTo(sourceX, sourceY);
        context.lineTo(target.x / 100 * width, target.y / 100 * height);
        context.strokeStyle = `${source.color}72`;
        context.lineWidth = 1 + Math.min(source.depth, target.depth);
        context.stroke();
      }
    }
  }, [ambientLayout, layout, stageSize]);

  function activate(partner) {
    if (partner.nodeAction === "promotion" && partner.promotionalImageUrl) setPreview(partner);
    else window.open(partner.websiteUrl, "_blank", "noopener,noreferrer");
  }

  function resetView() {
    setView(DEFAULT_VIEW);
    setPaused(false);
  }

  function startDrag(event) {
    if (event.target.closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, yaw: view.yaw, pitch: view.pitch };
    setDragging(true);
  }

  function moveDrag(event) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setView((current) => ({ ...current, yaw: drag.yaw + (event.clientX - drag.x) * 0.006, pitch: clamp(drag.pitch - (event.clientY - drag.y) * 0.004, -0.72, 0.72) }));
  }

  function endDrag(event) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  }

  function zoom(event) {
    event.preventDefault();
    setView((current) => ({ ...current, zoom: clamp(current.zoom - event.deltaY * 0.0007, 0.72, 1.42) }));
  }

  const networkStage = <div className={`partner-network-stage${fullScreen ? " is-fullscreen" : ""}${dragging ? " is-dragging" : ""}`} ref={stageRef} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onWheel={zoom} role={fullScreen ? "dialog" : undefined} aria-modal={fullScreen || undefined} aria-label={fullScreen ? "合作伙伴全息神经网络预览" : undefined}>
    <canvas ref={canvasRef} aria-hidden="true" />
    <div className="partner-network-stage-meta"><i /><span>BRAND NEURAL FIELD</span><strong>{visible.length} 个品牌 · {industry === "all" ? "全行业聚类" : industries.find(([key]) => key === industry)?.[1]}</strong></div>
    <div className="partner-network-controls" role="group" aria-label="品牌神经网络控制">
      <button type="button" aria-pressed={paused} onClick={() => setPaused((value) => !value)}>{paused ? <Play size={17} weight="fill" /> : <Pause size={17} weight="fill" />}{paused ? "继续" : "暂停"}</button>
      <button type="button" onClick={resetView}><Path size={17} />复位视角</button>
      <button className="primary" type="button" onClick={() => setFullScreen((value) => !value)}>{fullScreen ? <ArrowsIn size={18} /> : <ArrowsOut size={18} />}{fullScreen ? "退出全息" : "全息预览"}</button>
    </div>
    <div className="partner-network-core"><Handshake size={31} weight="duotone" /><strong>古龙生态</strong><span>GULONG</span></div>
    {layout.map((partner) => <button key={partner.id} className="partner-network-node" style={{ left: `${partner.x}%`, top: `${partner.y}%`, width: `${partner.size}px`, height: `${partner.size}px`, zIndex: Math.round(partner.depth * 100) + 10, opacity: 0.45 + partner.depth * 0.55, borderColor: `${partner.color}${Math.round(120 + partner.depth * 120).toString(16)}`, boxShadow: `0 0 ${16 + partner.depth * 34}px ${partner.color}${Math.round(38 + partner.depth * 50).toString(16)}, 0 ${8 + partner.depth * 15}px ${24 + partner.depth * 24}px rgba(0,0,0,.34)` }} onClick={() => activate(partner)} aria-label={`${partner.name}，${partner.nodeAction === "promotion" ? "查看宣传图片" : "打开官网"}`}><img src={partner.logoUrl} alt={`${partner.name} Logo`} /><span>{partner.name}</span>{partner.nodeAction === "promotion" ? <ImageSquare size={16} /> : <ArrowSquareOut size={16} />}</button>)}
  </div>;

  return <>
    <section className="partner-network-section section-shell" aria-labelledby="partners-title">
      <header className="partner-network-heading"><div><span>合作伙伴 · BRAND CONSTELLATION</span><h2 id="partners-title">他们都在用古龙智能引擎</h2><p>真实企业品牌按行业自动聚类，在持续运转的 3D 神经网络中彼此连接。拖拽旋转、滚轮缩放，点击品牌节点访问官网或查看宣传内容。</p></div><div className="partner-network-status"><i /><span>全息网络在线</span><strong>{partners.length} 个品牌节点</strong></div></header>
      <div className="partner-network-toolbar" role="group" aria-label="按行业筛选合作伙伴"><button className={industry === "all" ? "active" : ""} onClick={() => setIndustry("all")}>全部行业</button>{industries.map(([key, name]) => <button key={key} className={industry === key ? "active" : ""} onClick={() => setIndustry(key)}><i style={{ background: industryColors[key] || industryColors.other }} />{name}</button>)}</div>
      {!fullScreen && networkStage}
    </section>
    {fullScreen && createPortal(networkStage, document.body)}
    {preview && <div className="modal-backdrop partner-preview-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setPreview(null)}><section className="partner-preview-modal" role="dialog" aria-modal="true" aria-label={`${preview.name} 宣传图片`}><button className="modal-close" onClick={() => setPreview(null)}><X size={19} /></button><div><img src={preview.logoUrl} alt="" /><span>{preview.industryName}</span><h2>{preview.name}</h2></div><img className="partner-promotion-image" src={preview.promotionalImageUrl} alt={`${preview.name} 宣传图片`} /><a className="button secondary full" href={preview.websiteUrl} target="_blank" rel="noreferrer">访问企业官网 <ArrowSquareOut size={17} /></a></section></div>}
  </>;
}
