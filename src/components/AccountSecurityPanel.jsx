import { CheckCircle, DeviceMobile, EnvelopeSimple, Key, LockKey, ShieldCheck, SignOut, Star, Trash, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../api.js";
import { useConfirmDialog } from "./ConfirmDialog.jsx";

export function AccountSecurityPanel({ refreshKey = 0 }) {
  const confirmAction = useConfirmDialog();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [emailToken, setEmailToken] = useState("");
  const [phone, setPhone] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [reauthCode, setReauthCode] = useState("");
  const [passwords, setPasswords] = useState({ oldPassword: "", newPassword: "" });
  const [verification, setVerification] = useState({ identityId: "", code: "" });

  async function load() {
    setLoading(true); setError("");
    try { setData(await apiFetch("/api/account/security")); }
    catch (reason) { setError(reason.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [refreshKey]);
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown > 0]);

  const phoneIdentities = useMemo(() => (data?.identities || []).filter((item) => item.provider === "phone"), [data]);
  const emailVerified = Boolean(data?.profile?.emailVerified || (data?.identities || []).some((item) => item.provider === "email" && item.verified));

  async function sendVerificationEmail() {
    setBusy("email-send"); setError(""); setMessage("");
    try {
      await apiFetch("/api/account/security/email/send-verification", { method: "POST", body: "{}" });
      setCooldown(60);
      setMessage("验证邮件已发送，请检查收件箱和垃圾邮箱。");
    } catch (reason) { setError(reason.message); }
    finally { setBusy(""); }
  }

  async function verifyEmail(event) {
    event.preventDefault();
    setBusy("email-verify"); setError(""); setMessage("");
    try {
      await apiFetch("/api/account/security/email/verify", { method: "POST", body: JSON.stringify({ token: emailToken }) });
      setEmailToken("");
      setMessage("邮箱验证成功，现在可以安全绑定手机号。");
      await load();
    } catch (reason) { setError(reason.message); }
    finally { setBusy(""); }
  }

  async function bindPhone(event) {
    event.preventDefault();
    setBusy("phone-bind"); setError(""); setMessage("");
    try {
      const result = await apiFetch("/api/account/security/phone/bind", { method: "POST", body: JSON.stringify({ phone, currentPassword: currentPassword || undefined, reauthCode: reauthCode || undefined }) });
      setVerification({ identityId: result.identity.id, code: "" });
      setCurrentPassword("");
      setReauthCode("");
      setCooldown(60);
      setMessage("绑定短信已发送，请输入 6 位验证码完成绑定。");
      await load();
    } catch (reason) { setError(reason.message); }
    finally { setBusy(""); }
  }

  async function verifyPhone(event) {
    event.preventDefault();
    setBusy("phone-verify"); setError(""); setMessage("");
    try {
      await apiFetch(`/api/account/security/identities/${encodeURIComponent(verification.identityId)}/verify`, { method: "POST", body: JSON.stringify({ code: verification.code }) });
      setPhone("");
      setVerification({ identityId: "", code: "" });
      setMessage("手机号绑定成功，现在可用于短信验证码登录和找回密码。");
      await load();
    } catch (reason) { setError(reason.message); }
    finally { setBusy(""); }
  }

  async function unbindPhone(identity) {
    if (!await confirmAction({
      tone: "warning",
      eyebrow: "ACCOUNT SECURITY",
      title: "确认解绑手机号？",
      message: `解绑 ${identity.value} 后，将不能再使用该手机号接收登录和重置密码验证码。`,
      note: "邮箱登录与邮箱找回密码不受影响。",
      confirmLabel: "确认解绑",
    })) return;
    setBusy(`delete-${identity.id}`); setError(""); setMessage("");
    try {
      await apiFetch(`/api/account/security/identities/${encodeURIComponent(identity.id)}`, { method: "DELETE" });
      setMessage("手机号已经安全解绑。");
      await load();
    } catch (reason) { setError(reason.message); }
    finally { setBusy(""); }
  }

  async function sendReauthCode() {
    setBusy("reauth-send"); setError(""); setMessage("");
    try {
      const result = await apiFetch("/api/account/security/reauth/send", { method: "POST", body: "{}" });
      setCooldown(result.retryAfter || 60);
      setMessage(`再认证验证码已发送${result.value ? `到 ${result.value}` : "到当前主身份"}。`);
    } catch (reason) { setError(reason.message); }
    finally { setBusy(""); }
  }

  async function setPrimary(identity) {
    setBusy(`primary-${identity.id}`); setError(""); setMessage("");
    try {
      await apiFetch(`/api/account/security/identities/${encodeURIComponent(identity.id)}/primary`, { method: "POST", body: "{}" });
      setMessage("主身份已更新。");
      await load();
    } catch (reason) { setError(reason.message); }
    finally { setBusy(""); }
  }

  async function changePassword(event) {
    event.preventDefault();
    setBusy("password-change"); setError(""); setMessage("");
    try {
      await apiFetch("/api/account/security/password/change", { method: "POST", body: JSON.stringify(passwords) });
      setPasswords({ oldPassword: "", newPassword: "" });
      setMessage("密码已更新，其他设备的长期会话会按 Chandler 安全策略失效。");
    } catch (reason) { setError(reason.message); }
    finally { setBusy(""); }
  }

  async function logoutAll() {
    if (!await confirmAction({ tone: "warning", eyebrow: "SESSION SECURITY", title: "注销所有设备？", message: "这会撤销 Chandler 与古龙官网中的全部登录会话。", note: "操作完成后，当前浏览器也需要重新登录。", confirmLabel: "注销全部会话" })) return;
    setBusy("logout-all"); setError("");
    try {
      await apiFetch("/api/account/security/sessions/logout-all", { method: "POST", body: "{}" });
      window.location.assign("/");
    } catch (reason) { setError(reason.message); setBusy(""); }
  }

  if (loading && !data) return <section className="account-module account-security-module"><div className="account-security-loading"><span /><strong>正在读取账号安全状态</strong></div></section>;

  return <section className="account-module account-security-module">
    <header><div><span>ACCOUNT SECURITY</span><h2>账号安全</h2><p>官网账号通过邮箱注册；验证邮箱后可绑定手机号，用于短信验证码登录和找回密码。</p></div><div className="account-security-shield"><ShieldCheck size={24} weight="duotone" /> Chandler v3.7 安全认证</div></header>
    {message && <div className="account-message success">{message}</div>}
    {error && <div className="account-message error">{error}</div>}

    <div className="account-security-grid">
      <article className={emailVerified ? "verified" : "pending"}>
        <header><div className="security-icon"><EnvelopeSimple size={25} weight="duotone" /></div><div><span>注册邮箱</span><strong>{data?.profile?.email || "尚未读取"}</strong></div><em>{emailVerified ? <><CheckCircle size={18} weight="fill" /> 已验证</> : <><WarningCircle size={18} weight="fill" /> 待验证</>}</em></header>
        <p>{emailVerified ? "邮箱是账号的注册与恢复根身份，请长期保持可用。" : "完成邮箱验证后，才能绑定手机号，避免手机号被用于批量注册或短信轰炸。"}</p>
        {!emailVerified && <>
          <button className="button secondary full" type="button" disabled={busy === "email-send" || cooldown > 0} onClick={sendVerificationEmail}><EnvelopeSimple size={18} /> {cooldown > 0 ? `${cooldown} 秒后可重发` : busy === "email-send" ? "正在发送" : "发送邮箱验证邮件"}</button>
          <form className="security-inline-form" onSubmit={verifyEmail}><label><span>邮箱验证码或验证令牌</span><div><Key size={18} /><input required minLength={6} maxLength={2048} value={emailToken} onChange={(event) => setEmailToken(event.target.value.trim())} placeholder="粘贴邮件中的验证码或验证令牌" /></div></label><button className="button primary" disabled={busy === "email-verify"}>{busy === "email-verify" ? "正在验证" : "验证邮箱"}</button></form>
        </>}
      </article>

      <article className={phoneIdentities.some((item) => item.verified) ? "verified" : "pending"}>
        <header><div className="security-icon"><DeviceMobile size={25} weight="duotone" /></div><div><span>手机身份</span><strong>{phoneIdentities.length ? "已添加手机号" : "尚未绑定"}</strong></div><em>{data?.capabilities?.smsOtpEnabled ? "短信服务可用" : "短信服务暂停"}</em></header>
        <p>手机号仅用于已注册账号的登录、密码重置和安全验证，不开放手机号注册。</p>
        {phoneIdentities.length > 0 && <div className="security-identity-list">{phoneIdentities.map((identity) => <div key={identity.id}><span><DeviceMobile size={19} /><strong>{identity.value}</strong><small>{identity.verified ? "已验证，可用于验证码登录" : "等待输入短信验证码"}</small></span><div>{identity.isPrimary && <em><Star size={14} weight="fill" /> 主身份</em>}{identity.verified && !identity.isPrimary && <button type="button" className="button small secondary" disabled={busy === `primary-${identity.id}`} onClick={() => setPrimary(identity)}>设为主身份</button>}{!identity.verified && <button type="button" className="button small secondary" onClick={() => setVerification({ identityId: identity.id, code: "" })}>完成验证</button>}<button type="button" className="button small ghost danger" disabled={busy === `delete-${identity.id}`} onClick={() => unbindPhone(identity)}><Trash size={16} /> 解绑</button></div></div>)}</div>}

        {verification.identityId ? <form className="security-inline-form phone-verify" onSubmit={verifyPhone}><label><span>6 位短信验证码</span><div><Key size={18} /><input required autoFocus inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={verification.code} onChange={(event) => setVerification({ ...verification, code: event.target.value.replace(/\D/g, "") })} placeholder="输入短信验证码" /></div></label><button className="button primary" disabled={busy === "phone-verify"}>{busy === "phone-verify" ? "正在验证" : "完成绑定"}</button></form> : <form className="security-phone-form" onSubmit={bindPhone}>
          <label><span>手机号</span><div><DeviceMobile size={18} /><input required type="tel" disabled={!emailVerified || !data?.capabilities?.smsOtpEnabled} value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="大陆手机号或 +国家码国际手机号" /></div></label>
          <label><span>当前密码</span><div><LockKey size={18} /><input type="password" maxLength={255} disabled={!emailVerified || !data?.capabilities?.smsOtpEnabled} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" placeholder="有密码账号使用" /></div></label>
          <label><span>再认证码</span><div><Key size={18} /><input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} disabled={!emailVerified || !data?.capabilities?.smsOtpEnabled} value={reauthCode} onChange={(event) => setReauthCode(event.target.value.replace(/\D/g, ""))} placeholder="无密码账号使用" /></div></label>
          <button className="button secondary full" type="button" disabled={!emailVerified || busy === "reauth-send" || cooldown > 0} onClick={sendReauthCode}><Key size={18} /> {cooldown > 0 ? `${cooldown} 秒后可重发` : "获取再认证码"}</button>
          <button className="button primary full" disabled={!emailVerified || !data?.capabilities?.smsOtpEnabled || busy === "phone-bind"}><DeviceMobile size={18} /> {busy === "phone-bind" ? "正在发送短信" : "绑定手机并发送验证码"}</button>
        </form>}
      </article>
    </div>
    <div className="account-security-controls">
      <form onSubmit={changePassword}><div><span>PASSWORD</span><h3>修改登录密码</h3><p>由 Chandler 校验当前密码并执行统一修改。</p></div><label><span>当前密码</span><div><LockKey size={18} /><input required type="password" maxLength={255} value={passwords.oldPassword} onChange={(event) => setPasswords({ ...passwords, oldPassword: event.target.value })} autoComplete="current-password" /></div></label><label><span>新密码</span><div><Key size={18} /><input required type="password" minLength={8} maxLength={255} value={passwords.newPassword} onChange={(event) => setPasswords({ ...passwords, newPassword: event.target.value })} autoComplete="new-password" /></div></label><button className="button primary" disabled={busy === "password-change"}>更新密码</button></form>
      <div><div><span>ACTIVE SESSIONS</span><h3>注销所有设备</h3><p>撤销全部刷新令牌和官网会话，适用于设备丢失或发现异常登录。</p></div><button className="button ghost danger" type="button" disabled={busy === "logout-all"} onClick={logoutAll}><SignOut size={18} />注销全部会话</button></div>
    </div>
    <div className="account-security-note"><ShieldCheck size={20} /><p><strong>验证码防护已开启</strong>官网对 IP 与目标摘要双重限流，验证码 10 分钟有效、最多尝试 3 次；发送接口采用固定响应，不向未登录访客泄露账号是否存在。</p></div>
  </section>;
}
