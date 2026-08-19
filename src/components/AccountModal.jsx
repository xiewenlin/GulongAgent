import { ArrowLeft, EnvelopeSimple, Eye, EyeSlash, Key, LockKey, SignIn, UserCircle, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { apiFetch } from "../api.js";

const RESET_MIN_PASSWORD_LENGTH = 8;

function PasswordVisibilityButton({ visible, onChange, controls }) {
  function keepPasswordFieldActive(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  function toggleVisibility(event) {
    keepPasswordFieldActive(event);
    onChange((current) => !current);
  }

  return (
    <button
      className="password-visibility-toggle"
      type="button"
      aria-label={visible ? "隐藏密码" : "显示密码"}
      aria-controls={controls}
      aria-pressed={visible}
      onMouseDown={keepPasswordFieldActive}
      onClick={toggleVisibility}
    >
      {visible ? <EyeSlash size={18} /> : <Eye size={18} />}
    </button>
  );
}

export function AccountModal({ open, initialMode = "login", onClose, onUser, themeIcon }) {
  const [mode, setMode] = useState(initialMode);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [resetSent, setResetSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [form, setForm] = useState({ identifier: "", username: "", email: "", displayName: "", inviteCode: "", password: "", resetCode: "", newPassword: "", confirmPassword: "" });

  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setError("");
      setSuccess("");
      setResetSent(false);
      setCooldown(0);
    }
  }, [open, initialMode]);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown > 0]);

  if (!open) return null;

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      if (mode === "forgot") {
        if (!resetSent) {
          const result = await apiFetch("/api/auth/forgot-password", { method: "POST", body: JSON.stringify({ email: form.email }) });
          setResetSent(true);
          setCooldown(60);
          setSuccess(result.message || "验证码邮件已发送，请检查收件箱和垃圾邮箱");
          return;
        }
        if (form.newPassword !== form.confirmPassword) throw new Error("两次输入的新密码不一致");
        const result = await apiFetch("/api/auth/reset-password", { method: "POST", body: JSON.stringify({ email: form.email, code: form.resetCode, newPassword: form.newPassword }) });
        setForm((current) => ({ ...current, identifier: current.email, password: "", resetCode: "", newPassword: "", confirmPassword: "" }));
        setShowPassword(false);
        setResetSent(false);
        setMode("login");
        setSuccess(result.message || "密码已重置，请使用新密码登录");
        return;
      }
      const optionalText = (value) => value.trim() || undefined;
      const body = mode === "login"
        ? { identifier: form.identifier.trim(), password: form.password }
        : {
            email: form.email.trim(),
            username: optionalText(form.username),
            displayName: optionalText(form.displayName),
            inviteCode: optionalText(form.inviteCode),
            password: form.password,
          };
      const result = await apiFetch(`/api/auth/${mode}`, { method: "POST", body: JSON.stringify(body) });
      onUser(result.user);
      onClose();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }

  async function resendCode() {
    if (busy || cooldown > 0) return;
    setBusy(true); setError(""); setSuccess("");
    try {
      const result = await apiFetch("/api/auth/forgot-password", { method: "POST", body: JSON.stringify({ email: form.email }) });
      setCooldown(60);
      setSuccess(result.message || "新的验证码邮件已发送");
    } catch (reason) { setError(reason.message); }
    finally { setBusy(false); }
  }

  function switchMode(nextMode) {
    setMode(nextMode);
    setError(""); setSuccess(""); setShowPassword(false);
    if (nextMode !== "forgot") setResetSent(false);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-title">
        <button className="modal-close" type="button" aria-label="关闭" onClick={onClose}><X size={20} /></button>
        <div className="account-brand"><img src={themeIcon} alt="" /><span>Chandler × 古龙统一账号</span></div>
        <h2 id="account-title">{mode === "login" ? "欢迎回来" : mode === "register" ? "创建你的古龙账号" : resetSent ? "输入邮箱验证码" : "找回你的密码"}</h2>
        <p>{mode === "login" ? "使用用户名或邮箱继续进入开放平台。" : mode === "register" ? "注册后即可上传第二大脑、提交反馈并创建 API Key。" : resetSent ? "验证码已经发送到你的邮箱，校验后即可设置新密码。" : "输入注册邮箱，我们会发送一封安全验证邮件。"}</p>

        {mode === "forgot" ? <button type="button" className="account-back-login" onClick={() => switchMode("login")}><ArrowLeft size={18} /> 返回登录</button> : <div className="account-tabs" role="tablist">
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => switchMode("login")}>登录</button>
          <button type="button" className={mode === "register" ? "active" : ""} onClick={() => switchMode("register")}>注册</button>
        </div>}

        <form onSubmit={submit}>
          {mode === "login" && (
            <label><span>用户名或邮箱</span><div className="input-shell"><UserCircle size={18} /><input required value={form.identifier} onChange={(event) => setForm({ ...form, identifier: event.target.value })} autoComplete="username" placeholder="例如：gulong_dev 或 name@example.com" /></div></label>
          )}
          {mode === "register" && (
            <label><span>邮箱</span><div className="input-shell"><UserCircle size={18} /><input required type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} autoComplete="email" placeholder="name@example.com" /></div></label>
          )}
          {mode === "register" && (
            <>
              <label><span>用户名（可选，用于登录）</span><div className="input-shell"><UserCircle size={18} /><input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} autoComplete="username" placeholder="可输入中文、空格、符号或任意字符" /></div></label>
              <label><span>显示名称（可选）</span><div className="input-shell"><UserCircle size={18} /><input maxLength={64} value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="例如：施富" /></div></label>
              <label><span>邀请码（可选）</span><div className="input-shell"><UserCircle size={18} /><input maxLength={64} value={form.inviteCode} onChange={(event) => setForm({ ...form, inviteCode: event.target.value })} placeholder="如有邀请码可填写" /></div></label>
            </>
          )}
          {mode === "forgot" && <label><span>注册邮箱</span><div className="input-shell"><EnvelopeSimple size={18} /><input required disabled={resetSent} type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} autoComplete="email" placeholder="name@example.com" /></div></label>}
          {(mode === "login" || mode === "register") && <div className="account-password-field"><div className="account-label-row"><label htmlFor="account-password">密码</label>{mode === "login" && <button type="button" onClick={() => switchMode("forgot")}>忘记密码？</button>}</div><div className="input-shell"><LockKey size={18} /><input id="account-password" required type={showPassword ? "text" : "password"} minLength={1} maxLength={255} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder={mode === "register" ? "输入你要使用的密码" : "输入密码"} /><PasswordVisibilityButton visible={showPassword} onChange={setShowPassword} controls="account-password" /></div>{mode === "register" && <small className="account-password-help">官网不预先限制字符类型；如果统一账号服务判断密码过弱，会直接给出明确提示。</small>}</div>}
          {mode === "forgot" && resetSent && <>
            <div className="reset-email-confirm"><EnvelopeSimple size={18} /><span>验证邮件已发送至 <strong>{form.email}</strong></span><button type="button" onClick={() => { setResetSent(false); setSuccess(""); setError(""); }}>修改邮箱</button></div>
            <label><span>邮箱验证码</span><div className="input-shell"><Key size={18} /><input required minLength={6} maxLength={2048} value={form.resetCode} onChange={(event) => setForm({ ...form, resetCode: event.target.value.trim() })} autoComplete="one-time-code" placeholder="粘贴邮件中的验证码或重置令牌" /></div><small className="reset-code-help">邮件中如果显示为较长的重置令牌，也可直接完整粘贴到这里。</small></label>
            <div className="account-password-field"><label htmlFor="account-new-password">新密码</label><div className="input-shell"><LockKey size={18} /><input id="account-new-password" required type={showPassword ? "text" : "password"} minLength={RESET_MIN_PASSWORD_LENGTH} maxLength={255} value={form.newPassword} onChange={(event) => setForm({ ...form, newPassword: event.target.value })} autoComplete="new-password" placeholder="至少 8 位，建议混合字母、数字和符号" /><PasswordVisibilityButton visible={showPassword} onChange={setShowPassword} controls="account-new-password account-confirm-password" /></div></div>
            <label><span>确认新密码</span><div className="input-shell"><LockKey size={18} /><input id="account-confirm-password" required type={showPassword ? "text" : "password"} minLength={RESET_MIN_PASSWORD_LENGTH} maxLength={255} value={form.confirmPassword} onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })} autoComplete="new-password" placeholder="再次输入新密码" /></div></label>
            <div className="reset-code-actions"><span>没有收到？请同时检查垃圾邮箱</span><button type="button" disabled={busy || cooldown > 0} onClick={resendCode}>{cooldown > 0 ? `${cooldown} 秒后可重发` : "重新发送验证码"}</button></div>
          </>}
          {success && <div className="form-success" role="status">{success}</div>}
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="button primary full" type="submit" disabled={busy}>{busy ? "请稍候…" : <>{mode === "forgot" ? resetSent ? <Key size={18} /> : <EnvelopeSimple size={18} /> : <SignIn size={18} />} {mode === "login" ? "登录" : mode === "register" ? "创建账号" : resetSent ? "验证并重置密码" : "发送邮箱验证码"}</>}</button>
        </form>
        <small className="privacy-note">{mode === "forgot" ? "验证码与新密码由 Chandler 统一身份服务安全校验；重置成功后，原有登录会话会自动失效。" : "继续即表示你同意平台服务条款与隐私政策。账号与密码由 Chandler 统一身份服务处理，古龙官网不保存密码。"}</small>
      </section>
    </div>
  );
}
