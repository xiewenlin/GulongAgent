export const SUBSCRIPTION_PRODUCTS = [
  {id:"member",name:"古龙会员",description:"第二大脑与官网会员能力，按此产品的独立有效期生效。"},
  {id:"short_video_monthly",name:"短视频包月",description:"MiniMaxH3共享节点订阅；手动修改有效期不会增加付费额度。"},
  {id:"english_coach_monthly",name:"英语教练包月",monthlyFen:19800,description:"¥198 / 月 · 英语教练桌面端与订阅内共享能力，独立于其他会员。"},
  {id:"gulong_engine_monthly",name:"古龙引擎包月",monthlyFen:19800,description:"¥198 / 月 · 绿色版 Agent、免费文本模型与已验证共享节点，独立于其他会员。"},
];
export function localSubscriptionDate(value) {
  if(!value)return "";
  const date=new Date(value);
  return Number.isFinite(date.getTime())?new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16):"";
}
export function editorProducts({products=[],subscriptions=[],user={}}={},now=new Date()) {
  const catalog=new Map(SUBSCRIPTION_PRODUCTS.map(product=>[product.id,{...product}]));
  for(const item of products)if(item?.id)catalog.set(item.id,{...catalog.get(item.id),...item});
  return [...catalog.values()].map(product=>{
    const explicit=products.find(item=>item.id===product.id);
    const legacy=subscriptions.find(item=>item.authoritative&&item.plan===product.id)
      ||subscriptions.find(item=>item.source==="website"&&item.plan===product.id&&item.current_period_end);
    const match=explicit||legacy||((user.subscription_plan||"member")===product.id&&user.membership_valid_until?user:null);
    const start=match?.currentPeriodStart||match?.current_period_start||match?.valid_from;
    const end=match?.currentPeriodEnd||match?.current_period_end||match?.valid_until||match?.membership_valid_until;
    const enabled=typeof match?.enabled==="boolean"?match.enabled:!!(end&&!['cancelled','canceled','inactive'].includes(match?.status));
    return {...product,name:product.name||product.id,enabled,currentPeriodStart:localSubscriptionDate(start||now),currentPeriodEnd:localSubscriptionDate(end||new Date(now.getTime()+30*86400000)),status:match?.status||"inactive",hasExisting:!!match};
  });
}
export function subscriptionChanges(rows,baseline) {
  const changes=[];
  for(const row of rows) {
    const old=baseline.find(item=>item.id===row.id);
    if(!old)throw new Error("订阅产品发生变化，请重新打开设置。");
    const datesChanged=row.currentPeriodStart!==old.currentPeriodStart||row.currentPeriodEnd!==old.currentPeriodEnd;
    if(row.enabled===old.enabled&&(!row.enabled||!datesChanged))continue;
    if(!row.enabled){changes.push({id:row.id,enabled:false});continue;}
    const start=new Date(row.currentPeriodStart),end=new Date(row.currentPeriodEnd);
    if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end<=start)throw new Error(`${row.name}：到期时间必须晚于生效时间。`);
    changes.push({id:row.id,enabled:true,currentPeriodStart:start.toISOString(),currentPeriodEnd:end.toISOString()});
  }
  return changes;
}
export function subscriptionOrderName(order) {
  const plan=order.planType||order.subscriptionPlan||order.partnerData?.subscription_plan;
  if(plan==="english_coach_monthly")return "英语教练包月 · 月度";
  if(plan==="gulong_engine_monthly")return "古龙引擎包月 · 月度";
  if(plan==="short_video_monthly")return `短视频包月 · ${order.cycle==="year"?"年度":"月度"}`;
  return order.cycle==="year"?"年度会员":"月度会员";
}
export function subscriptionCycle(plan,cycle) {return ["english_coach_monthly","gulong_engine_monthly"].includes(plan.id)?"month":cycle;}
