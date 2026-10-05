import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { createForm, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';

type IssueStatus = 'open' | 'triaged' | 'fixing' | 'verifying' | 'closed' | 'reopened';
type Severity = 'critical' | 'serious' | 'moderate' | 'minor';
type PersonId = 'auditor-a' | 'auditor-b' | 'auditor-c' | 'coordinator';

interface Person { id: PersonId; name: string; role: 'auditor' | 'coordinator' }
interface Lease {
  ownerId: PersonId;
  expiresAt: string;
  status: 'active' | 'expired';
  draftStatus?: IssueStatus;
  draftNote?: string;
}
interface Handover {
  fromId: PersonId;
  toId: PersonId;
  status: 'pending' | 'returned';
  draftStatus?: IssueStatus;
  draftNote?: string;
  createdAt: string;
}
interface AuditIssue {
  id: string;
  title: string;
  flow: string;
  steps: string;
  impactGroup: string;
  severity: Severity;
  status: IssueStatus;
  canonicalId?: string;
  fixNote: string;
  retestNote: string;
  updatedAt: string;
  lease: Lease | null;
  handover: Handover | null;
}
interface AuditEvent { id: string; at: string; issueId: string; actorId: PersonId | ''; message: string }
interface WorkbenchState { version: 2; issues: AuditIssue[]; events: AuditEvent[] }
interface PendingSubmit { issueId: string; status: IssueStatus; note: string }

const LEASE_TTL_MS = 60_000;
const STORAGE_KEY = 'a11y-audit-v2';

const people: Person[] = [
  { id: 'auditor-a', name: '审计员 林岚', role: 'auditor' },
  { id: 'auditor-b', name: '审计员 周越', role: 'auditor' },
  { id: 'auditor-c', name: '审计员 陈临', role: 'auditor' },
  { id: 'coordinator', name: '协调员 顾恒', role: 'coordinator' }
];
const personName = (id: PersonId | '') => (id === '' ? '系统' : people.find((person) => person.id === id)?.name ?? id);
const person = (id: PersonId) => people.find((person) => person.id === id)!;
const auditors = people.filter((item) => item.role === 'auditor');

const statusLabels: Record<IssueStatus, string> = {
  open: '待分诊',
  triaged: '已分诊',
  fixing: '修复中',
  verifying: '复测中',
  closed: '已关闭',
  reopened: '重新打开'
};
const severityLabels: Record<Severity, string> = { critical: '阻断', serious: '严重', moderate: '中等', minor: '轻微' };

const isoMinus = (ms: number) => new Date(Date.now() - ms).toISOString();

const seed: WorkbenchState = {
  version: 2,
  issues: [
    { id: 'issue-1', title: '结算弹窗关闭后焦点丢失', flow: '订单结算', steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点', impactGroup: '键盘与读屏用户', severity: 'serious', status: 'triaged', fixNote: '等待修复排期', retestNote: '', updatedAt: isoMinus(3600_000), lease: null, handover: null },
    { id: 'issue-2', title: '错误提示未与输入框关联', flow: '账户设置', steps: '输入无效手机号后使用读屏读取输入框', impactGroup: '读屏用户', severity: 'moderate', status: 'fixing', fixNote: '已增加 aria-describedby，等待构建', retestNote: '', updatedAt: isoMinus(7200_000), lease: null, handover: null },
    { id: 'issue-3', title: '支付页验证码图片无替代文本', flow: '订单支付', steps: '1. 进入收银台\n2. 唤起图形验证码\n3. 开启读屏', impactGroup: '读屏用户', severity: 'critical', status: 'open', fixNote: '', retestNote: '', updatedAt: isoMinus(900_000), lease: null, handover: null },
    { id: 'issue-4', title: '登录链接颜色对比度不足', flow: '账户登录', steps: '在浅色背景下检查“忘记密码”链接文字对比度', impactGroup: '低视力用户', severity: 'minor', status: 'open', fixNote: '', retestNote: '', updatedAt: isoMinus(300_000), lease: null, handover: null }
  ],
  events: [
    { id: 'e-1', at: isoMinus(3600_000), issueId: 'issue-1', actorId: 'auditor-a', message: '审核员确认问题有效并进入修复中' },
    { id: 'e-2', at: isoMinus(7000_000), issueId: 'issue-2', actorId: 'auditor-b', message: '开发人员提交焦点管理修复' }
  ]
};

const issueSchema = z.object({
  title: z.string().min(4, '标题至少4个字'),
  flow: z.string().min(2, '请输入业务流程'),
  steps: z.string().min(8, '请写清复现步骤'),
  impactGroup: z.string().min(2, '请选择受影响人群'),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor'])
});
type IssueForm = z.infer<typeof issueSchema>;

const dictionaries = {
  zh: flatten({ title: '无障碍人工审计协作工作台', subtitle: '问题、修复与复测协作', issues: '审计问题', events: '操作时间线' }),
  en: flatten({ title: 'Accessibility Audit Workbench', subtitle: 'Issues, fixes and retesting', issues: 'Audit issues', events: 'Activity timeline' })
};

function loadState(): WorkbenchState {
  if (typeof localStorage === 'undefined') return seed;
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as WorkbenchState | null;
    if (parsed && parsed.version === 2 && Array.isArray(parsed.issues)) return parsed;
  } catch { /* fall through to seed */ }
  return seed;
}

function loadIdentity(): PersonId {
  if (typeof localStorage === 'undefined') return 'auditor-a';
  const saved = localStorage.getItem('a11y-audit-identity') as PersonId | null;
  return saved && people.some((item) => item.id === saved) ? saved : 'auditor-a';
}

export default function AuditWorkbench() {
  const queryClient = useQueryClient();
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));
  const [state, setState] = createStore<WorkbenchState>(loadState());
  const [identity, setIdentity] = createSignal<PersonId>(loadIdentity());
  const [now, setNow] = createSignal(Date.now());
  const [selectedId, setSelectedId] = createSignal(state.issues[0]?.id ?? '');
  const [mergeInto, setMergeInto] = createSignal('');
  const [assignTo, setAssignTo] = createSignal<PersonId>('auditor-a');
  const [notice, setNotice] = createSignal<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [pendingSubmit, setPendingSubmit] = createSignal<PendingSubmit | null>(null);
  const [draftStatus, setDraftStatus] = createSignal<IssueStatus>('triaged');
  const [draftNote, setDraftNote] = createSignal('');

  const issueQuery = createQuery(() => ({
    queryKey: ['audit-issues', state.issues.length],
    queryFn: async () => new Promise<AuditIssue[]>((resolve) => window.setTimeout(() => resolve(state.issues), 120))
  }));

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious' },
    validate: zodForm(issueSchema)
  });

  const selected = createMemo(() => state.issues.find((issue) => issue.id === selectedId()) ?? state.issues[0]);
  const me = createMemo(() => person(identity()));

  const leaseActive = (issue: AuditIssue, at = now()) =>
    !!issue.lease && issue.lease.status === 'active' && new Date(issue.lease.expiresAt).getTime() > at;
  const remainingMs = (issue: AuditIssue) =>
    issue.lease ? Math.max(0, new Date(issue.lease.expiresAt).getTime() - now()) : 0;
  const formatRemaining = (ms: number) => `${Math.ceil(ms / 1000)} 秒`;

  createEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  });
  createEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('a11y-audit-identity', identity());
  });

  // 每秒检查租约到期；非阻断问题回到待分诊可被接管，阻断问题仅挂起等待协调员指派。
  const tickExpirations = () => {
    const at = Date.now();
    let changed = false;
    setState('issues', (issues) => issues.map((issue) => {
      if (leaseActive(issue, at)) return issue;
      if (!issue.lease || issue.lease.status === 'expired') return issue;
      // 草稿移交等待新处理人确认期间不自动到期，避免冲掉待吸收/退回流程。
      if (issue.handover?.status === 'pending') return { ...issue, lease: { ...issue.lease, expiresAt: new Date(at + 30_000).toISOString() } };
      changed = true;
      if (issue.severity === 'critical') {
        return {
          ...issue,
          status: 'open',
          lease: { ...issue.lease, status: 'expired' as const },
          updatedAt: new Date(at).toISOString()
        };
      }
      const ownerId = issue.lease.ownerId;
      setState('events', (events) => [{
        id: crypto.randomUUID(), at: new Date(at).toISOString(), issueId: issue.id, actorId: '',
        message: `${personName(ownerId)} 的租约到期，问题回到待分诊，可由他人接管`
      }, ...events]);
      return { ...issue, status: 'open', lease: null, updatedAt: new Date(at).toISOString() };
    }));
    if (changed) void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  onMount(() => {
    tickExpirations();
    const timer = window.setInterval(() => { setNow(Date.now()); tickExpirations(); }, 1000);
    const shortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'n' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('#issue-title')?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    onCleanup(() => { window.clearInterval(timer); window.removeEventListener('keydown', shortcut); });
  });

  // 切换问题时重置草稿、指派对象、挂起重试。
  createEffect(() => {
    const issue = selected();
    setNotice(null);
    setPendingSubmit(null);
    setDraftStatus(issue?.lease?.draftStatus ?? 'triaged');
    setDraftNote(issue?.lease?.draftNote ?? '');
    setAssignTo(auditors.find((item) => item.id !== issue?.lease?.ownerId)?.id ?? 'auditor-a');
  });

  const addEvent = (issueId: string, message: string, actorId: PersonId | '') =>
    setState('events', (events) => [{ id: crypto.randomUUID(), at: new Date().toISOString(), issueId, message, actorId }, ...events]);

  const noteFor = (status: IssueStatus, note: string) => {
    if (!note) return {};
    if (['fixing', 'verifying'].includes(status)) return { fixNote: note };
    if (['closed', 'reopened'].includes(status)) return { retestNote: note };
    return { fixNote: note };
  };

  // 状态修改的统一入口：只认当前持有效租约的处理人，否则拒绝并返回当前处理人。
  const submitStatus = (issueId: string, status: IssueStatus, note: string): { ok: boolean; error?: string } => {
    const issue = state.issues.find((item) => item.id === issueId);
    if (!issue) return { ok: false, error: '问题不存在' };
    if (me().role !== 'auditor') return { ok: false, error: '只有审计员可以提交状态修改' };
    if (issue.handover?.status === 'pending') {
      return { ok: false, error: `该问题有待 ${personName(issue.handover.toId)} 确认的移交草稿，暂不能提交其他修改` };
    }
    if (leaseActive(issue)) {
      if (issue.lease!.ownerId !== me().id) {
        return { ok: false, error: `提交被拒绝：问题正由 ${personName(issue.lease!.ownerId)} 处理，租约剩余 ${formatRemaining(remainingMs(issue))}` };
      }
      setState('issues', (item) => item.id === issueId, produce((target) => {
        Object.assign(target, { status, ...noteFor(status, note), lease: null, updatedAt: new Date().toISOString() });
      }));
      addEvent(issueId, `${personName(me().id)} 提交状态：${statusLabels[status]}`, me().id);
      return { ok: true };
    }
    if (issue.lease?.status === 'expired' && issue.severity === 'critical') {
      return { ok: false, error: '阻断问题的到期租约不能自动换人，请等待协调员重新指派' };
    }
    return { ok: false, error: '你尚未持有该问题的有效租约，可先认领再提交' };
  };

  // 带失败重试的提交：冲突时记下意图，拿到租约后一键重试。
  const attemptStatusSubmit = (issueId: string, status: IssueStatus, note: string) => {
    const result = submitStatus(issueId, status, note);
    if (result.ok) {
      setNotice({ kind: 'ok', text: `已提交：${statusLabels[status]}` });
      setPendingSubmit(null);
      return;
    }
    setNotice({ kind: 'error', text: result.error ?? '提交失败' });
    setPendingSubmit({ issueId, status, note });
  };

  const claimIssue = (issueId: string): { ok: boolean; error?: string } => {
    const issue = state.issues.find((item) => item.id === issueId);
    if (!issue) return { ok: false, error: '问题不存在' };
    if (me().role !== 'auditor') return { ok: false, error: '协调员不能直接认领问题' };
    if (issue.handover?.status === 'pending') {
      return { ok: false, error: `问题有待 ${personName(issue.handover.toId)} 确认的移交草稿` };
    }
    if (leaseActive(issue)) {
      if (issue.lease!.ownerId === me().id) return { ok: true }; // 同一问题重复认领幂等，不算两次
      return { ok: false, error: `问题已由 ${personName(issue.lease!.ownerId)} 认领，租约剩余 ${formatRemaining(remainingMs(issue))}` };
    }
    if (issue.lease?.status === 'expired' && issue.severity === 'critical') {
      return { ok: false, error: '阻断问题租约到期后不能自行接管，请等待协调员指派' };
    }
    const alreadyClaimed = state.events.some(
      (event) => event.issueId === issueId && event.actorId === me().id && event.message.includes('认领问题')
    );
    setState('issues', (item) => item.id === issueId, produce((target) => {
      target.lease = {
        ownerId: me().id,
        expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString(),
        status: 'active',
        draftStatus: 'triaged',
        draftNote: ''
      };
      target.status = 'open';
      target.updatedAt = new Date().toISOString();
    }));
    // 同一问题重复认领不能算两次：仅在首次认领时写时间线。
    if (!alreadyClaimed) addEvent(issueId, `${personName(me().id)} 认领问题并开始处理`, me().id);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
    return { ok: true };
  };

  const releaseLease = (issueId: string) => {
    const issue = state.issues.find((item) => item.id === issueId);
    if (!issue || !leaseActive(issue) || issue.lease!.ownerId !== me().id) return;
    setState('issues', (item) => item.id === issueId, produce((target) => {
      target.lease = null;
      target.status = 'open';
      target.updatedAt = new Date().toISOString();
    }));
    addEvent(issueId, `${personName(me().id)} 释放处理租约，问题回到待分诊`, me().id);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const saveDraft = (issueId: string) => {
    const issue = state.issues.find((item) => item.id === issueId);
    if (!issue || !leaseActive(issue) || issue.lease!.ownerId !== me().id) return;
    setState('issues', (item) => item.id === issueId, produce((target) => {
      if (target.lease) {
        target.lease.draftStatus = draftStatus();
        target.lease.draftNote = draftNote();
      }
      target.updatedAt = new Date().toISOString();
    }));
    addEvent(issueId, `${personName(me().id)} 暂存分诊草稿`, me().id);
    setNotice({ kind: 'ok', text: '草稿已暂存到当前租约' });
  };

  // 协调员指派：阻断问题到期挂起后必须走这里；原处理人草稿转为待移交。
  const assignIssue = (issueId: string, toId: PersonId) => {
    const issue = state.issues.find((item) => item.id === issueId);
    if (!issue) { setNotice({ kind: 'error', text: '问题不存在' }); return; }
    if (me().role !== 'coordinator') { setNotice({ kind: 'error', text: '只有协调员可以指派问题' }); return; }
    if (leaseActive(issue)) { setNotice({ kind: 'error', text: `租约仍有效，当前处理人是 ${personName(issue.lease!.ownerId)}` }); return; }
    if (person(toId).role !== 'auditor' || toId === me().id) { setNotice({ kind: 'error', text: '请选择一名审计员作为新处理人' }); return; }
    if (issue.handover?.status === 'pending') { setNotice({ kind: 'error', text: '已有待确认的移交，请先处理' }); return; }
    const fromId = issue.lease?.ownerId;
    const draftStatusValue = issue.lease?.draftStatus;
    const draftNoteValue = issue.lease?.draftNote;
    const hasDraft = !!(draftStatusValue && (draftNoteValue || draftStatusValue !== 'triaged'));
    setState('issues', (item) => item.id === issueId, produce((target) => {
      target.handover = hasDraft && fromId && fromId !== toId
        ? { fromId, toId, status: 'pending', draftStatus: draftStatusValue, draftNote: draftNoteValue, createdAt: new Date().toISOString() }
        : null;
      target.lease = { ownerId: toId, expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString(), status: 'active' };
      target.status = 'open';
      target.updatedAt = new Date().toISOString();
    }));
    addEvent(issueId, `协调员 ${personName(me().id)} 将问题指派给 ${personName(toId)}${fromId && fromId !== toId ? `，原处理人 ${personName(fromId)} 的草稿转为待移交` : ''}`, me().id);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
    setNotice({ kind: 'ok', text: `已指派给 ${personName(toId)}` });
  };

  // 新处理人确认吸收草稿：草稿内容落到问题，时间线记在新处理人名下。
  const acceptHandover = (issueId: string) => {
    const issue = state.issues.find((item) => item.id === issueId);
    const handover = issue?.handover;
    if (!issue || !handover || handover.status !== 'pending' || handover.toId !== me().id) return;
    const status = handover.draftStatus ?? 'triaged';
    setState('issues', (item) => item.id === issueId, produce((target) => {
      Object.assign(target, { status, ...noteFor(status, handover.draftNote ?? ''), handover: null, lease: null, updatedAt: new Date().toISOString() });
    }));
    addEvent(issueId, `${personName(me().id)} 确认吸收 ${personName(handover.fromId)} 的移交草稿（${statusLabels[status]}）`, me().id);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
    setNotice({ kind: 'ok', text: '已吸收原处理人草稿并提交' });
  };

  // 新处理人退回草稿：阻断问题重新挂起等待协调员再指派；非阻断回到待分诊可认领。
  const returnHandover = (issueId: string) => {
    const issue = state.issues.find((item) => item.id === issueId);
    const handover = issue?.handover;
    if (!issue || !handover || handover.status !== 'pending' || handover.toId !== me().id) return;
    setState('issues', (item) => item.id === issueId, produce((target) => {
      target.handover = null;
      target.status = 'open';
      target.updatedAt = new Date().toISOString();
      if (target.severity === 'critical') {
        target.lease = { ownerId: handover.fromId, expiresAt: new Date().toISOString(), status: 'expired' };
      } else {
        target.lease = null;
      }
    }));
    addEvent(issueId, `${personName(me().id)} 退回 ${personName(handover.fromId)} 的移交草稿，问题回到待分诊`, me().id);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
    setNotice({ kind: 'warn', text: '已退回移交草稿' });
  };

  const createIssue = (values: IssueForm) => {
    const issue: AuditIssue = {
      id: crypto.randomUUID(), ...values, status: 'open', fixNote: '', retestNote: '',
      updatedAt: new Date().toISOString(), lease: null, handover: null
    };
    setState('issues', (issues) => [issue, ...issues]);
    setSelectedId(issue.id);
    addEvent(issue.id, `${personName(me().id)} 创建问题并保存证据`, me().id);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const mergeDuplicate = () => {
    const duplicate = selected();
    const canonical = state.issues.find((issue) => issue.id === mergeInto());
    if (!duplicate || !canonical || duplicate.id === canonical.id) return;
    if (me().role !== 'auditor') { setNotice({ kind: 'error', text: '只有审计员可以执行重复合并' }); return; }
    if (!leaseActive(duplicate) || duplicate.lease!.ownerId !== me().id) {
      setNotice({ kind: 'error', text: leaseActive(duplicate) ? `合并被拒绝：当前处理人是 ${personName(duplicate.lease!.ownerId)}` : '请先认领该问题再合并' });
      return;
    }
    setState('issues', (issue) => issue.id === duplicate.id, produce((target) => {
      target.canonicalId = canonical.id;
      target.lease = null;
      target.updatedAt = new Date().toISOString();
    }));
    addEvent(duplicate.id, `${personName(me().id)} 将重复问题合并到 ${canonical.title}`, me().id);
    setSelectedId(canonical.id);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const claimAndRetry = () => {
    const pending = pendingSubmit();
    if (!pending) return;
    const claim = claimIssue(pending.issueId);
    if (!claim.ok) { setNotice({ kind: 'error', text: claim.error ?? '认领失败，无法重试' }); return; }
    attemptStatusSubmit(pending.issueId, pending.status, pending.note);
  };

  const statusButtons: Array<{ status: IssueStatus; label: string; note: string; danger?: boolean }> = [
    { status: 'triaged', label: '确认问题', note: '审核员完成分诊' },
    { status: 'fixing', label: '开始修复', note: '修复进行中，等待提交复测版本' },
    { status: 'verifying', label: '提交复测', note: '' },
    { status: 'closed', label: '复测通过', note: '键盘、读屏和错误提示均已通过' },
    { status: 'reopened', label: '复测失败', note: '焦点顺序仍不正确', danger: true }
  ];

  const myActiveCount = () => state.issues.filter((issue) => leaseActive(issue) && issue.lease!.ownerId === me().id).length;
  const expiredCriticalCount = () => state.issues.filter(
    (issue) => issue.severity === 'critical' && issue.lease?.status === 'expired'
  ).length;

  return (
    <>
      <a class="skip-link" href="#main-content">跳到主要内容</a>
      <main class="shell" id="main-content">
        <header class="hero">
          <div><span class="badge">WCAG 人工审计协作</span><h1>{t()('title')}</h1><p>{t()('subtitle')} · 租约 {LEASE_TTL_MS / 1000} 秒 · 快捷键 N 聚焦新建问题，Ctrl+Enter 提交</p></div>
          <div class="identity-bar">
            <span class="identity-label">当前身份</span>
            <div class="role-switch" role="group" aria-label="身份切换">
              <For each={people}>{(item) => (
                <button
                  class={identity() === item.id ? 'identity-on' : 'secondary'}
                  aria-pressed={identity() === item.id}
                  onClick={() => setIdentity(item.id)}
                >
                  {item.role === 'coordinator' ? '协调员' : '审计员'} · {item.name.replace(/^[^ ]+ /, '')}
                </button>
              )}</For>
            </div>
            <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>{language() === 'zh' ? 'English' : '中文'}</button>
          </div>
        </header>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>全部问题</span><strong>{state.issues.length}</strong></div>
          <div class="card"><span>待修复</span><strong>{state.issues.filter((issue) => ['open', 'triaged', 'fixing', 'reopened'].includes(issue.status)).length}</strong></div>
          <div class="card"><span>待复测</span><strong>{state.issues.filter((issue) => issue.status === 'verifying').length}</strong></div>
          <div class="card"><span>已关闭</span><strong>{state.issues.filter((issue) => issue.status === 'closed').length}</strong></div>
        </section>

        <Show when={expiredCriticalCount() > 0 && me().role === 'auditor'}>
          <p class="banner warn" role="status">有 {expiredCriticalCount()} 个阻断问题租约到期后挂起，等待协调员指派。</p>
        </Show>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')} <small>{issueQuery.isSuccess ? '同步正常' : '同步中'}</small></h2>
            <For each={state.issues}>{(issue) => (
              <article class="issue">
                <h3><button class="secondary" onClick={() => setSelectedId(issue.id)} aria-current={selectedId() === issue.id ? 'true' : undefined}>{issue.title}</button></h3>
                <div class="meta">
                  <span class="badge">{statusLabels[issue.status]}</span>
                  <span class="badge" class:severity-critical={issue.severity === 'critical'}>{severityLabels[issue.severity]}</span>
                  <span>{issue.flow}</span>
                  <Show when={issue.canonicalId}><span class="badge">重复项</span></Show>
                  <Show when={leaseActive(issue)}>
                    <span class="badge lease-on" aria-label={`处理人 ${personName(issue.lease!.ownerId)}`}>
                      {personName(issue.lease!.ownerId)} 处理中 · {formatRemaining(remainingMs(issue))}
                    </span>
                  </Show>
                  <Show when={issue.lease?.status === 'expired'}>
                    <span class="badge lease-expired">{issue.severity === 'critical' ? '到期挂起·待协调员指派' : '租约到期'}</span>
                  </Show>
                  <Show when={issue.handover?.status === 'pending'}>
                    <span class="badge handover">草稿待移交确认</span>
                  </Show>
                </div>
              </article>
            )}</For>
          </section>

          <section class="card" aria-labelledby="detail-title">
            <h2 id="detail-title">问题详情与状态流转</h2>
            <Show when={selected()} fallback={<p role="status">暂无审计问题。</p>}>{(_) => {
              const issue = selected()!;
              const iOwn = () => leaseActive(issue) && issue.lease!.ownerId === me().id;
              const handoverToMe = () => issue.handover?.status === 'pending' && issue.handover.toId === me().id;
              return <>
                <h3>{issue.title}</h3>
                <p><strong>复现步骤：</strong>{issue.steps}</p>
                <p><strong>修复记录：</strong>{issue.fixNote || '尚未填写'}</p>
                <p><strong>复测记录：</strong>{issue.retestNote || '尚未填写'}</p>

                <div class="lease-panel" aria-live="polite">
                  <Show when={leaseActive(issue) && iOwn()} fallback={
                    <Show when={leaseActive(issue)}>
                      <p class="banner warn">当前由 <strong>{personName(issue.lease!.ownerId)}</strong> 处理，租约剩余 {formatRemaining(remainingMs(issue))}。有效期内你的状态修改会被拒绝。</p>
                    </Show>
                  }>
                    <p class="banner ok">你持有处理租约，剩余 {formatRemaining(remainingMs(issue))}。到期或释放后问题回到待分诊。</p>
                    <label>草稿：拟流转状态
                      <select value={draftStatus()} onChange={(event) => setDraftStatus(event.currentTarget.value as IssueStatus)}>
                        <For each={(['triaged', 'fixing', 'verifying', 'closed', 'reopened'] as IssueStatus[])}>
                          {(status) => <option value={status}>{statusLabels[status]}</option>}
                        </For>
                      </select>
                    </label>
                    <label>草稿备注<textarea rows={2} value={draftNote()} onInput={(event) => setDraftNote(event.currentTarget.value)} placeholder="分诊意见 / 修复或复测说明" /></label>
                    <div class="row">
                      <button class="secondary" onClick={() => saveDraft(issue.id)}>暂存草稿</button>
                      <button class="danger" onClick={() => releaseLease(issue.id)}>释放租约</button>
                    </div>
                  </Show>

                  <Show when={issue.lease?.status === 'expired' && !leaseActive(issue)}>
                    <Show when={issue.severity === 'critical'} fallback={
                      <div class="row">
                        <p class="banner warn" style="margin:0">租约已到期，问题回到待分诊，可以接管。</p>
                        <button onClick={() => {
                          const result = claimIssue(issue.id);
                          setNotice(result.ok ? { kind: 'ok', text: '已接管问题' } : { kind: 'error', text: result.error ?? '认领失败' });
                        }}>接管问题</button>
                      </div>
                    }>
                      <p class="banner warn">阻断问题的到期租约不会自动换人，原处理人 {personName(issue.lease!.ownerId)} 的草稿保留，需由协调员指派。</p>
                    </Show>
                  </Show>

                  <Show when={!issue.lease && issue.status === 'open' && issue.handover?.status !== 'pending'}>
                    <div class="row">
                      <p class="banner" style="margin:0">问题待分诊，无人持有租约。</p>
                      <button onClick={() => {
                        const result = claimIssue(issue.id);
                        setNotice(result.ok
                          ? { kind: 'ok', text: state.events.some((event) => event.issueId === issue.id && event.actorId === me().id && event.message.includes('认领问题')) ? '已重新持有租约（不重复计入认领）' : '已认领，租约开始计时' }
                          : { kind: 'error', text: result.error ?? '认领失败' });
                      }}>认领并开始处理</button>
                    </div>
                  </Show>

                  <Show when={handoverToMe()}>
                    <div class="handover-box">
                      <p><strong>{personName(issue.handover!.fromId)}</strong> 的草稿待你确认：拟流转为 <strong>{statusLabels[issue.handover!.draftStatus ?? 'triaged']}</strong>{issue.handover!.draftNote ? `，备注：${issue.handover!.draftNote}` : ''}</p>
                      <div class="row">
                        <button onClick={() => acceptHandover(issue.id)}>吸收草稿</button>
                        <button class="danger" onClick={() => returnHandover(issue.id)}>退回草稿</button>
                      </div>
                    </div>
                  </Show>

                  <Show when={me().role === 'coordinator' && !leaseActive(issue) && issue.handover?.status !== 'pending'}>
                    <div class="coordinator-box">
                      <label>指派给
                        <select value={assignTo()} onChange={(event) => setAssignTo(event.currentTarget.value as PersonId)}>
                          <For each={auditors.filter((item) => item.id !== issue.lease?.ownerId)}>{(item) =>
                            <option value={item.id}>{item.name}</option>
                          }</For>
                        </select>
                      </label>
                      <button onClick={() => assignIssue(issue.id, assignTo())}>协调员指派</button>
                      <Show when={issue.lease?.status === 'expired'}>
                        <p class="meta">到期挂起问题指派后，原处理人草稿将转为待移交，由新处理人吸收或退回。</p>
                      </Show>
                    </div>
                  </Show>
                </div>

                <Show when={me().role === 'auditor' && issue.handover?.status !== 'pending'}>
                  <div role="group" aria-label="问题状态操作" class="status-actions">
                    <For each={statusButtons}>{(action) => (
                      <button class={action.danger ? 'danger' : ''} onClick={() => attemptStatusSubmit(issue.id, action.status, action.note)}>{action.label}</button>
                    )}</For>
                  </div>
                </Show>

                <Show when={notice()}>
                  <p class={`banner ${notice()!.kind}`} role="alert">{notice()!.text}</p>
                </Show>
                <Show when={pendingSubmit() && pendingSubmit()!.issueId === issue.id}>
                  <div class="retry-box" role="alert">
                    <span>上次提交（{statusLabels[pendingSubmit()!.status]}）未成功，已保留提交内容。</span>
                    <button class="secondary" onClick={claimAndRetry}>认领/等待租约后重试</button>
                  </div>
                </Show>

                <Show when={me().role === 'auditor'}>
                  <hr />
                  <label>合并到主问题<select value={mergeInto()} onChange={(event) => setMergeInto(event.currentTarget.value)}><option value="">选择问题</option><For each={state.issues.filter((item) => item.id !== issue.id && !item.canonicalId)}>{(item) => <option value={item.id}>{item.title}</option>}</For></select></label>
                  <button disabled={!mergeInto()} onClick={mergeDuplicate}>确认重复合并</button>
                </Show>
              </>;
            }}</Show>
          </section>
        </div>

        <div class="grid" style="margin-top:18px">
          <Show when={me().role === 'auditor'}>
            <section class="card">
              <h2>新建审计问题</h2>
              <AuditForm onSubmit={createIssue} style="margin-top:12px">
                <AuditField name="title">{ (field, props) => <label>问题标题<input id="issue-title" {...props} aria-invalid={field.error ? 'true' : undefined} aria-describedby={field.error ? 'title-error' : undefined} /><Show when={field.error}><p class="error" id="title-error" role="alert">{field.error}</p></Show></label> }</AuditField>
                <AuditField name="flow">{ (_field, props) => <label>业务流程<input {...props} /></label> }</AuditField>
                <AuditField name="steps">{ (_field, props) => <label>复现步骤<textarea {...props} rows={4} /></label> }</AuditField>
                <AuditField name="impactGroup">{ (_field, props) => <label>影响人群<select {...props}><option>键盘与读屏用户</option><option>低视力用户</option><option>认知障碍用户</option><option>行动障碍用户</option></select></label> }</AuditField>
                <AuditField name="severity">{ (_field, props) => <label>严重程度<select {...props}><option value="critical">阻断</option><option value="serious">严重</option><option value="moderate">中等</option><option value="minor">轻微</option></select></label> }</AuditField>
                <button type="submit">创建问题</button>
              </AuditForm>
            </section>
          </Show>

          <section class={`card tabs ${me().role === 'coordinator' ? 'full-width' : ''}`}>
            <h2>{t()('events')} <small>时间线归属与当前处理人一致</small></h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List><Tabs.Trigger value="activity">操作记录</Tabs.Trigger><Tabs.Trigger value="rules">租约规则</Tabs.Trigger></Tabs.List>
              <Tabs.Content value="activity">
                <div class="timeline" aria-live="polite">
                  <For each={state.events.slice(0, 16)}>{(event) => (
                    <div style="margin-bottom:12px">
                      <strong>{new Date(event.at).toLocaleString()}</strong>
                      <div><span class={`badge ${event.actorId === '' ? 'system-actor' : ''}`}>{personName(event.actorId)}</span> {event.message}</div>
                    </div>
                  )}</For>
                </div>
              </Tabs.Content>
              <Tabs.Content value="rules"><ul>
                <li>开始处理即领取 {LEASE_TTL_MS / 1000} 秒租约，记录处理人与到期时刻；同一问题重复认领只计一次。</li>
                <li>租约有效期内，其他人提交状态修改会被拒绝，并提示当前处理人与剩余时间；提交失败可保留内容重试。</li>
                <li>到期或本人释放后问题回到待分诊，他人可以接管。</li>
                <li>阻断问题到期后不自动换人，由协调员指派；原处理人草稿转为待移交，新处理人确认吸收或退回。</li>
                <li>时间线每条操作都记录实际处理人，与问题当前处理状态保持一致。</li>
              </ul></Tabs.Content>
            </Tabs.Root>
          </section>
        </div>

        <p class="meta" aria-live="polite">当前身份：{me().name}（{me().role === 'coordinator' ? '协调员' : '审计员'}）；我持有的有效租约 {myActiveCount()} 个。</p>
      </main>
    </>
  );
}
