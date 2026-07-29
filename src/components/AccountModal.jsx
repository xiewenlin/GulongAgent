import { Eye, EyeSlash, LockKey, SignIn, UserCircle, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { apiFetch } from "../api.js";

export function AccountModal({ open, initialMode = "login", onClose, onUser, themeIcon }) {
  const [mode, setMode] = useState(initialMode);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ identifier: "", username: "", email: "", displayName: "", inviteCode: "", password: "" });

  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setError("");
    }
  }, [open, initialMode]);

  if (!open) return null;

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = mode === "login"
        ? { identifier: form.identifier, password: form.password }
        : { email: form.email, username: form.username || undefined, displayName: form.displayName || undefined, inviteCode: form.inviteCode || undefined, password: form.password };
      const result = await apiFetch(`/api/auth/${mode}`, { method: "POST", body: JSON.stringify(body) });
      onUser(result.user);
      onClose();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-title">
        <button className="modal-close" type="button" aria-label="关闭" onClick={onClose}><X size={20} /></button>
        <div className="account-brand"><img src={themeIcon} alt="" /><span>Chandler × 古龙统一账号</span></div>
        <h2 id="account-title">{mode === "login" ? "欢迎回来" : "创建你的古龙账号"}</h2>
        <p>{mode === "login" ? "使用用户名或邮箱继续进入开放平台。" : "注册后即可上传第二大脑、提交反馈并创建 API Key。"}</p>

        <div className="account-tabs" role="tablist">
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>登录</button>
          <button type="button" className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>注册</button>
        </div>

        <form onSubmit={submit}>
          {mode === "login" && (
            <label><span>用户名或邮箱</span><div className="input-shell"><UserCircle size={18} /><input required value={form.identifier} onChange={(event) => setForm({ ...form, identifier: event.target.value })} autoComplete="username" placeholder="例如：gulong_dev 或 name@example.com" /></div></label>
          )}
          {mode === "register" && (
            <label><span>邮箱</span><div className="input-shell"><UserCircle size={18} /><input required type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} autoComplete="email" placeholder="name@example.com" /></div></label>
          )}
          {mode === "register" && (
            <>
              <label><span>用户名（可选，用于登录）</span><div className="input-shell"><UserCircle size={18} /><input minLength={3} maxLength={32} value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} autoComplete="username" placeholder="3–32 个字符" /></div></label>
              <label><span>显示名称（可选）</span><div className="input-shell"><UserCircle size={18} /><input maxLength={64} value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="例如：施富" /></div></label>
              <label><span>邀请码（可选）</span><div className="input-shell"><UserCircle size={18} /><input maxLength={64} value={form.inviteCode} onChange={(event) => setForm({ ...form, inviteCode: event.target.value })} placeholder="如有邀请码可填写" /></div></label>
            </>
          )}
          <label><span>密码</span><div className="input-shell"><LockKey size={18} /><input required type={showPassword ? "text" : "password"} minLength={mode === "register" ? 10 : 1} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder={mode === "register" ? "至少 10 位，建议使用密码管理器" : "输入密码"} /><button type="button" aria-label={showPassword ? "隐藏密码" : "显示密码"} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeSlash size={18} /> : <Eye size={18} />}</button></div></label>
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="button primary full" type="submit" disabled={busy}>{busy ? "请稍候…" : <><SignIn size={18} /> {mode === "login" ? "登录" : "创建账号"}</>}</button>
        </form>
        <small className="privacy-note">继续即表示你同意平台服务条款与隐私政策。账号与密码由 Chandler 统一身份服务处理，古龙官网不保存密码。</small>
      </section>
    </div>
  );
}
