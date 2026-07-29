import { ArrowSquareOut, Handshake, ImageSquare, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";

const industryColors = {
  technology: "#177b74",
  finance: "#bd8630",
  education: "#5b78a9",
  healthcare: "#4a8b6f",
  commerce: "#b96c59",
  industry: "#64706d",
  culture: "#8a64a6",
  public: "#567c91",
  services: "#90794d",
  other: "#7c817e",
};

export function PartnerNetwork({ partners }) {
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const [angle, setAngle] = useState(0);
  const [paused, setPaused] = useState(false);
  const [industry, setIndustry] = useState("all");
  const [preview, setPreview] = useState(null);

  const industries = useMemo(() => {
    const map = new Map();
    for (const partner of partners) map.set(partner.industryKey || "other", partner.industryName || "其他行业");
    return [...map.entries()];
  }, [partners]);
  const visible = useMemo(() => industry === "all" ? partners : partners.filter((partner) => (partner.industryKey || "other") === industry), [industry, partners]);
  const layout = useMemo(() => {
    const groupKeys = [...new Set(visible.map((partner) => partner.industryKey || "other"))];
    return visible.map((partner, index) => {
      const groupIndex = Math.max(0, groupKeys.indexOf(partner.industryKey || "other"));
      const groupCount = Math.max(1, groupKeys.length);
      const theta = angle + (index / Math.max(1, visible.length)) * Math.PI * 2 + groupIndex * 0.42;
      const depth = (Math.sin(theta) + 1) / 2;
      const lane = (groupIndex - (groupCount - 1) / 2) * Math.min(8, 32 / groupCount);
      return {
        ...partner,
        x: 50 + Math.cos(theta) * (34 - (groupIndex % 3) * 2.5),
        y: 50 + lane + Math.sin(theta * 1.16 + groupIndex * 0.7) * 13,
        depth,
        size: 72 + depth * 62,
        color: industryColors[partner.industryKey] || industryColors.other,
      };
    });
  }, [angle, visible]);

  useEffect(() => {
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (paused || reduceMotion) return undefined;
    let frame;
    let previous = performance.now();
    const animate = (now) => {
      if (now - previous > 42) {
        setAngle((value) => value + 0.0048 * Math.min(2.2, (now - previous) / 42));
        previous = now;
      }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [paused]);

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    const rect = stage.getBoundingClientRect();
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    const context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    for (let index = 0; index < layout.length; index += 1) {
      const source = layout[index];
      const sourceX = (source.x / 100) * width;
      const sourceY = (source.y / 100) * height;
      context.beginPath();
      context.moveTo(width / 2, height / 2);
      context.lineTo(sourceX, sourceY);
      context.strokeStyle = `${source.color}${Math.round(28 + source.depth * 24).toString(16).padStart(2, "0")}`;
      context.lineWidth = 0.8 + source.depth;
      context.stroke();
      for (let candidate = index + 1; candidate < layout.length; candidate += 1) {
        const target = layout[candidate];
        if (target.industryKey !== source.industryKey || candidate - index > 4) continue;
        context.beginPath();
        context.moveTo(sourceX, sourceY);
        context.lineTo((target.x / 100) * width, (target.y / 100) * height);
        context.strokeStyle = `${source.color}32`;
        context.lineWidth = 1;
        context.stroke();
      }
    }
  }, [layout]);

  function activate(partner) {
    if (partner.nodeAction === "promotion" && partner.promotionalImageUrl) setPreview(partner);
    else window.open(partner.websiteUrl, "_blank", "noopener,noreferrer");
  }

  return <>
    <section className="partner-network-section section-shell" aria-labelledby="partners-title">
      <header className="partner-network-heading"><div><span>合作伙伴 · BRAND CONSTELLATION</span><h2 id="partners-title">他们都在用古龙智能引擎</h2><p>真实企业品牌按行业自动聚类，在持续运转的神经网络中彼此连接。点击节点，访问企业官网或查看品牌宣传内容。</p></div><div className="partner-network-status"><i /><span>全息网络在线</span><strong>{partners.length} 个品牌节点</strong></div></header>
      <div className="partner-network-toolbar" role="group" aria-label="按行业筛选合作伙伴"><button className={industry === "all" ? "active" : ""} onClick={() => setIndustry("all")}>全部行业</button>{industries.map(([key, name]) => <button key={key} className={industry === key ? "active" : ""} onClick={() => setIndustry(key)}><i style={{ background: industryColors[key] || industryColors.other }} />{name}</button>)}</div>
      <div className="partner-network-stage" ref={stageRef} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
        <canvas ref={canvasRef} aria-hidden="true" />
        <div className="partner-network-core"><Handshake size={28} weight="duotone" /><strong>古龙生态</strong><span>GULONG</span></div>
        {layout.map((partner) => <button key={partner.id} className="partner-network-node" style={{ left: `${partner.x}%`, top: `${partner.y}%`, width: `${partner.size}px`, height: `${partner.size}px`, zIndex: Math.round(partner.depth * 100), opacity: 0.58 + partner.depth * 0.42, borderColor: `${partner.color}88`, boxShadow: `0 ${8 + partner.depth * 16}px ${20 + partner.depth * 22}px ${partner.color}26` }} onClick={() => activate(partner)} aria-label={`${partner.name}，${partner.nodeAction === "promotion" ? "查看宣传图片" : "打开官网"}`}><img src={partner.logoUrl} alt={`${partner.name} Logo`} /><span>{partner.name}</span>{partner.nodeAction === "promotion" ? <ImageSquare size={16} /> : <ArrowSquareOut size={16} />}</button>)}
        <div className="partner-network-note"><strong>{paused ? "已暂停，方便选择节点" : "品牌网络正在实时旋转"}</strong><span>越靠近前方的品牌节点越大 · 行业相同的节点自动连线</span></div>
      </div>
    </section>
    {preview && <div className="modal-backdrop partner-preview-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setPreview(null)}><section className="partner-preview-modal" role="dialog" aria-modal="true" aria-label={`${preview.name} 宣传图片`}><button className="modal-close" onClick={() => setPreview(null)}><X size={19} /></button><div><img src={preview.logoUrl} alt="" /><span>{preview.industryName}</span><h2>{preview.name}</h2></div><img className="partner-promotion-image" src={preview.promotionalImageUrl} alt={`${preview.name} 宣传图片`} /><a className="button secondary full" href={preview.websiteUrl} target="_blank" rel="noreferrer">访问企业官网 <ArrowSquareOut size={17} /></a></section></div>}
  </>;
}
