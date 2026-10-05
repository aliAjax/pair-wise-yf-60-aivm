import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { createForm, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';

type IssueStatus = 'open' | 'triaged' | 'fixing' | 'verifying' | 'closed' | 'reopened';
type Severity = 'critical' | 'serious' | 'moderate' | 'minor';
type Role = 'auditor' | 'coordinator';

interface Lease {
  handlerId: string;
  handlerName: string;
  acquiredAt: string;
  expiresAt: string;
  status: 'active' | 'expired';
}
interface Assignment {
  assignedToId: string;
  assignedToName: string;
  assignedById: string;
  assignedByName: string;
  at: string;
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
  lease?: Lease;
  draft?: string;
  pendingAssignment?: boolean;
  assignment?: Assignment;
}
interface AuditEvent { id: string; at: string; issueId: string; message: string }
interface WorkbenchState { issues: AuditIssue[]; events: AuditEvent[] }

const LEASE_DURATION_MS = 5 * 60_000;
const AUDITORS = [
  { id: 'auditor-lin', name: '林晓' },
  { id: 'auditor-chen', name: '陈默' },
  { id: 'auditor-wang', name: '王芳' }
];
const COORDINATOR = { id: 'coordinator-zhao', name: '赵协调' };

const seed: WorkbenchState = {
  issues: [
    { id: 'issue-1', title: '结算弹窗关闭后焦点丢失', flow: '订单结算', steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点', impactGroup: '键盘与读屏用户', severity: 'serious', status: 'triaged', fixNote: '', retestNote: '', updatedAt: new Date(Date.now() - 3600_000).toISOString(),
      lease: { handlerId: 'auditor-lin', handlerName: '林晓', acquiredAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString(), status: 'active' } },
    { id: 'issue-2', title: '错误提示未与输入框关联', flow: '账户设置', steps: '输入无效手机号后使用读屏读取输入框', impactGroup: '读屏用户', severity: 'moderate', status: 'fixing', fixNote: '已增加 aria-describedby，等待构建', retestNote: '', updatedAt: new Date(Date.now() - 7200_000).toISOString() },
    { id: 'issue-3', title: '报名弹窗读屏朗读顺序错乱', flow: '活动报名', steps: '1. 打开活动报名弹窗\n2. 听读屏朗读顺序', impactGroup: '键盘与读屏用户', severity: 'critical', status: 'open', fixNote: '', retestNote: '', updatedAt: new Date(Date.now() - 900_000).toISOString(),
      lease: { handlerId: 'auditor-chen', handlerName: '陈默', acquiredAt: new Date(Date.now() - 600_000).toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString(), status: 'expired' },
      draft: '复现：打开报名弹窗后，Tab 焦点跳到背景页链接，读屏先朗读背景导航而非弹窗标题。初步判断焦点未 trapping，需补 focus-trap。',
      pendingAssignment: true }
  ],
  events: [
    { id: 'e-1', at: new Date(Date.now() - 3600_000).toISOString(), issueId: 'issue-1', message: '审核员确认问题有效并进入修复中' },
    { id: 'e-2', at: new Date(Date.now() - 7000_000).toISOString(), issueId: 'issue-2', message: '开发人员提交焦点管理修复' },
    { id: 'e-3', at: new Date(Date.now() - 600_000).toISOString(), issueId: 'issue-3', message: '审计员 陈默 认领问题并开始处理' },
    { id: 'e-4', at: new Date(Date.now() - 60_000).toISOString(), issueId: 'issue-3', message: '阻断问题处理租约到期（原处理人 陈默），按规定不自动换人，等待协调员指派' }
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
  zh: flatten({ title: '无障碍人工审计协作工作台', subtitle: '问题、修复与复测协作', issues: '审计问题', merge: '重复合并', events: '操作时间线' }),
  en: flatten({ title: 'Accessibility Audit Workbench', subtitle: 'Issues, fixes and retesting', issues: 'Audit issues', merge: 'Duplicate merge', events: 'Activity timeline' })
};

function loadState(): WorkbenchState {
  if (typeof localStorage === 'undefined') return seed;
  try { return JSON.parse(localStorage.getItem('a11y-audit-v2') ?? 'null') as WorkbenchState ?? seed; } catch { return seed; }
}

function loadIdentity(): { role: Role; auditorId: string } {
  if (typeof localStorage === 'undefined') return { role: 'auditor', auditorId: AUDITORS[0].id };
  try {
    const raw = JSON.parse(localStorage.getItem('a11y-audit-identity') ?? 'null');
    return {
      role: raw?.role === 'coordinator' ? 'coordinator' : 'auditor',
      auditorId: AUDITORS.some((auditor) => auditor.id === raw?.auditorId) ? raw.auditorId : AUDITORS[0].id
    };
  } catch { return { role: 'auditor', auditorId: AUDITORS[0].id }; }
}

export default function AuditWorkbench() {
  const queryClient = useQueryClient();
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));
  const [state, setState] = createStore<WorkbenchState>(loadState());
  const [selectedId, setSelectedId] = createSignal(state.issues[0]?.id ?? '');
  const [mergeInto, setMergeInto] = createSignal('');
  const storedIdentity = loadIdentity();
  const [role, setRole] = createSignal<Role>(storedIdentity.role);
  const [auditorId, setAuditorId] = createSignal(storedIdentity.auditorId);
  const [now, setNow] = createSignal(Date.now());
  const [actionError, setActionError] = createSignal<{ issueId: string; message: string } | null>(null);
  const [assignTarget, setAssignTarget] = createSignal<Record<string, string>>({});

  const currentUser = createMemo(() => role() === 'coordinator'
    ? COORDINATOR
    : AUDITORS.find((auditor) => auditor.id === auditorId()) ?? AUDITORS[0]);
  const isCoordinator = createMemo(() => role() === 'coordinator');

  const issueQuery = createQuery(() => ({
    queryKey: ['audit-issues', state.issues.length],
    queryFn: async () => new Promise<AuditIssue[]>((resolve) => window.setTimeout(() => resolve(state.issues), 120))
  }));

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious' },
    validate: zodForm(issueSchema)
  });

  const selected = createMemo(() => state.issues.find((issue) => issue.id === selectedId()) ?? state.issues[0]);

  createEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('a11y-audit-v2', JSON.stringify(state));
  });
  createEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('a11y-audit-identity', JSON.stringify({ role: role(), auditorId: auditorId() }));
  });

  const addEvent = (issueId: string, message: string) => setState('events', (events) => [{ id: crypto.randomUUID(), at: new Date().toISOString(), issueId, message }, ...events]);

  const formatRemaining = (lease: Lease) => {
    const total = Math.floor(Math.max(0, new Date(lease.expiresAt).getTime() - now()) / 1000);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  };

  const claimState = (issue: AuditIssue): 'mine' | 'other' | 'blocked' | 'claimable' => {
    if (issue.assignment || issue.pendingAssignment || issue.lease?.status === 'expired') return 'blocked';
    if (issue.lease?.status === 'active') return issue.lease.handlerId === currentUser().id ? 'mine' : 'other';
    return 'claimable';
  };

  const claimIssue = (issue: AuditIssue) => {
    const me = currentUser();
    if (isCoordinator()) { setActionError({ issueId: issue.id, message: '协调员身份不能认领处理，请切换为审计员身份。' }); return; }
    const claim = claimState(issue);
    if (claim === 'mine') {
      setActionError(null); // 同一处理人重复认领：幂等，不重复计数、不写时间线
      return;
    }
    if (claim === 'blocked') {
      setActionError({ issueId: issue.id, message: issue.severity === 'critical'
        ? '阻断问题租约已到期，按规定不自动换人，需由协调员指派后才能接管。'
        : '该问题处于待移交或待指派状态，暂不能认领。' });
      return;
    }
    if (claim === 'other') {
      setActionError({ issueId: issue.id, message: `认领被拒绝：该问题正由 ${issue.lease!.handlerName} 处理中，租约剩余 ${formatRemaining(issue.lease!)}。请待其释放或租约到期后再接管。` });
      return;
    }
    const lease: Lease = {
      handlerId: me.id, handlerName: me.name,
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + LEASE_DURATION_MS).toISOString(),
      status: 'active'
    };
    setState('issues', (current) => current.id === issue.id, produce((draft) => {
      draft.lease = lease;
      draft.draft = draft.draft ?? '';
      draft.updatedAt = new Date().toISOString();
    }));
    addEvent(issue.id, `审计员 ${me.name} 认领问题并开始处理，租约至 ${new Date(lease.expiresAt).toLocaleTimeString()}，到期未提交则回到待分诊`);
    setActionError(null);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const requireLease = (issue: AuditIssue): { ok: true } | { ok: false; message: string } => {
    if (isCoordinator()) return { ok: false, message: '协调员不能直接修改问题状态；阻断问题请走指派流程。' };
    if (issue.assignment) return { ok: false, message: '该问题处于待移交确认中，暂不能修改状态。' };
    if (issue.pendingAssignment || issue.lease?.status === 'expired') return { ok: false, message: '阻断问题租约已到期并等待协调员指派，暂不能处理。' };
    if (!issue.lease || issue.lease.status !== 'active') return { ok: false, message: '问题暂无处理人，请先认领并开始处理。' };
    if (issue.lease.handlerId !== currentUser().id) {
      return { ok: false, message: `提交被拒绝：该问题正由 ${issue.lease.handlerName} 处理中（租约至 ${new Date(issue.lease.expiresAt).toLocaleTimeString()}）。他人提交会覆盖其分诊结果，请等待释放或到期后接管。` };
    }
    return { ok: true };
  };

  const performAction = (issue: AuditIssue, patch: Partial<AuditIssue>, message: string) => {
    const guard = requireLease(issue);
    if (!guard.ok) { setActionError({ issueId: issue.id, message: guard.message }); return; } // 失败不落库、不写时间线，可直接重试
    const me = currentUser();
    setState('issues', (current) => current.id === issue.id, produce((draft) => {
      Object.assign(draft, patch, { updatedAt: new Date().toISOString() });
      const lease = draft.lease;
      if (lease && lease.handlerId === me.id) {
        lease.expiresAt = new Date(Date.now() + LEASE_DURATION_MS).toISOString(); // 处理人持续操作时自动续期
      }
    }));
    addEvent(issue.id, `${me.name}：${message}`);
    setActionError(null);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const releaseIssue = (issue: AuditIssue) => {
    const me = currentUser();
    if (!issue.lease || issue.lease.handlerId !== me.id) {
      setActionError({ issueId: issue.id, message: '只有当前处理人本人可以释放租约。' });
      return;
    }
    setState('issues', (current) => current.id === issue.id, produce((draft) => {
      delete draft.lease;
      delete draft.draft;
      draft.updatedAt = new Date().toISOString();
    }));
    addEvent(issue.id, `${me.name} 完成处理并释放租约，问题回到待分诊，可由他人接管`);
    setActionError(null);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const saveDraft = (issue: AuditIssue, text: string) => {
    if (!issue.lease || issue.lease.handlerId !== currentUser().id) return;
    setState('issues', (current) => current.id === issue.id, produce((draft) => {
      draft.draft = text;
    }));
  };

  const assignIssue = (issue: AuditIssue) => {
    if (!isCoordinator()) { setActionError({ issueId: issue.id, message: '只有协调员可以指派阻断问题。' }); return; }
    const target = AUDITORS.find((auditor) => auditor.id === assignTarget()[issue.id]);
    if (!target) { setActionError({ issueId: issue.id, message: '请先选择要指派的审计员。' }); return; }
    if (!issue.pendingAssignment && issue.lease?.status !== 'expired') { setActionError({ issueId: issue.id, message: '该问题当前无需指派。' }); return; }
    const coordinator = currentUser();
    setState('issues', (current) => current.id === issue.id, produce((draft) => {
      draft.assignment = {
        assignedToId: target.id, assignedToName: target.name,
        assignedById: coordinator.id, assignedByName: coordinator.name,
        at: new Date().toISOString()
      };
      draft.pendingAssignment = false;
      draft.updatedAt = new Date().toISOString();
    }));
    addEvent(issue.id, `协调员 ${coordinator.name} 指派 ${target.name} 接管阻断问题；原处理人 ${issue.lease!.handlerName} 的草稿转为待移交，等待 ${target.name} 确认吸收或退回`);
    setActionError(null);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const absorbAssignment = (issue: AuditIssue) => {
    const me = currentUser();
    const assignment = issue.assignment;
    if (!assignment || assignment.assignedToId !== me.id) { setActionError({ issueId: issue.id, message: '该移交不是指派给你的，无法确认。' }); return; }
    const oldHandler = issue.lease?.handlerName ?? '原处理人';
    const draft = issue.draft ?? '';
    setState('issues', (current) => current.id === issue.id, produce((draftState) => {
      if (draft.trim()) draftState.fixNote = draftState.fixNote ? `${draftState.fixNote}\n${draft}` : draft;
      draftState.lease = {
        handlerId: me.id, handlerName: me.name,
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + LEASE_DURATION_MS).toISOString(),
        status: 'active'
      };
      delete draftState.assignment;
      delete draftState.draft;
      draftState.updatedAt = new Date().toISOString();
    }));
    addEvent(issue.id, `${me.name} 确认吸收原处理人 ${oldHandler} 的待移交草稿，草稿并入修复记录，${me.name} 接管并开始处理`);
    setActionError(null);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const returnAssignment = (issue: AuditIssue) => {
    const me = currentUser();
    const assignment = issue.assignment;
    if (!assignment || assignment.assignedToId !== me.id) { setActionError({ issueId: issue.id, message: '该移交不是指派给你的，无法操作。' }); return; }
    setState('issues', (current) => current.id === issue.id, produce((draft) => {
      delete draft.assignment;
      draft.pendingAssignment = true; // 退回后回到协调员重新指派队列
      draft.updatedAt = new Date().toISOString();
    }));
    addEvent(issue.id, `${me.name} 退回此次接管；待移交草稿保留，问题返回协调员处重新指派`);
    setActionError(null);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const createIssue = (values: IssueForm) => {
    const issue: AuditIssue = { id: crypto.randomUUID(), ...values, status: 'open', fixNote: '', retestNote: '', updatedAt: new Date().toISOString() };
    setState('issues', (issues) => [issue, ...issues]);
    setSelectedId(issue.id);
    addEvent(issue.id, '审计员创建问题并保存证据');
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const mergeDuplicate = () => {
    const duplicate = selected();
    const canonical = state.issues.find((issue) => issue.id === mergeInto());
    if (!duplicate || !canonical || duplicate.id === canonical.id) return;
    const guard = requireLease(duplicate);
    if (!guard.ok) { setActionError({ issueId: duplicate.id, message: guard.message }); return; }
    performAction(duplicate, { canonicalId: canonical.id }, `将重复问题合并到 ${canonical.title}`);
    setSelectedId(canonical.id);
  };

  onMount(() => {
    const tick = () => {
      const n = Date.now();
      setNow(n);
      const expiring = state.issues.filter((issue) => issue.lease?.status === 'active' && new Date(issue.lease.expiresAt).getTime() <= n);
      if (expiring.length === 0) return;
      setState('issues', produce((issues) => {
        for (const issue of issues) {
          if (issue.lease?.status === 'active' && new Date(issue.lease.expiresAt).getTime() <= n) {
            if (issue.severity === 'critical') {
              issue.lease.status = 'expired';
              issue.pendingAssignment = true; // 阻断问题到期不自动换人，进入协调员指派队列
            } else {
              delete issue.lease;
              delete issue.draft;
            }
          }
        }
      }));
      for (const issue of expiring) {
        if (issue.severity === 'critical') {
          addEvent(issue.id, `阻断问题处理租约到期（原处理人 ${issue.lease!.handlerName}），按规定不自动换人，等待协调员指派`);
        } else {
          addEvent(issue.id, `处理租约到期，${issue.lease!.handlerName} 释放租约，问题回到待分诊，可由他人接管`);
        }
      }
      void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
    };
    const timer = window.setInterval(tick, 1000);
    const shortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'n' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA' && document.activeElement?.tagName !== 'SELECT') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('#issue-title')?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    onCleanup(() => {
      window.clearInterval(timer);
      window.removeEventListener('keydown', shortcut);
    });
  });

  return (
    <>
      <a class="skip-link" href="#main-content">跳到主要内容</a>
      <main class="shell" id="main-content">
        <header class="hero">
          <div><span class="badge">WCAG 人工审计协作</span><h1>{t()('title')}</h1><p>{t()('subtitle')} · 快捷键 N 聚焦新建问题，Ctrl+Enter 提交</p></div>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
            <div class="badge" role="group" aria-label="身份切换" style="display:flex;gap:6px;align-items:center">
              <button aria-pressed={role() === 'auditor'} onClick={() => setRole('auditor')} style={role() === 'auditor' ? '' : 'background:#e2eeee;color:#174b51'}>审计员</button>
              <button aria-pressed={role() === 'coordinator'} onClick={() => setRole('coordinator')} style={role() === 'coordinator' ? '' : 'background:#e2eeee;color:#174b51'}>协调员</button>
              <Show when={role() === 'auditor'}>
                <select aria-label="选择审计员身份" value={auditorId()} onChange={(event) => setAuditorId(event.currentTarget.value)} style="padding:4px 6px;border-radius:6px">
                  <For each={AUDITORS}>{(auditor) => <option value={auditor.id}>{auditor.name}</option>}</For>
                </select>
              </Show>
              <span>当前：{currentUser().name}</span>
            </div>
            <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>{language() === 'zh' ? 'English' : '中文'}</button>
          </div>
        </header>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>全部问题</span><strong>{state.issues.length}</strong></div>
          <div class="card"><span>待修复</span><strong>{state.issues.filter((issue) => ['open', 'triaged', 'fixing', 'reopened'].includes(issue.status)).length}</strong></div>
          <div class="card"><span>待复测</span><strong>{state.issues.filter((issue) => issue.status === 'verifying').length}</strong></div>
          <div class="card"><span>已关闭</span><strong>{state.issues.filter((issue) => issue.status === 'closed').length}</strong></div>
          <div class="card"><span>待指派阻断</span><strong>{state.issues.filter((issue) => issue.pendingAssignment && !issue.assignment).length}</strong></div>
        </section>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')} <small>{issueQuery.isSuccess ? '同步正常' : '同步中'}</small></h2>
            <For each={state.issues}>{(issue) => (
              <article class="issue">
                <h3><button class="secondary" onClick={() => setSelectedId(issue.id)} aria-current={selectedId() === issue.id ? 'true' : undefined}>{issue.title}</button></h3>
                <div class="meta">
                  <span class="badge">{issue.status}</span>
                  <span class="badge">{issue.severity}</span>
                  <span>{issue.flow}</span>
                  <span>{issue.impactGroup}</span>
                  <Show when={issue.canonicalId}><span class="badge">重复项</span></Show>
                  <Show when={issue.assignment}><span class="badge">待移交{issue.assignment?.assignedToId === currentUser().id ? '（待我确认）' : ` → ${issue.assignment?.assignedToName}`}</span></Show>
                  <Show when={issue.pendingAssignment && !issue.assignment}><span class="badge" style="background:#fdecea;color:#b42318">待协调员指派</span></Show>
                  <Show when={issue.lease?.status === 'active' && !issue.assignment && !issue.pendingAssignment}>
                    <span class="badge">{issue.lease!.handlerId === currentUser().id ? '我处理中' : `${issue.lease!.handlerName} 处理中`} · 剩余 {formatRemaining(issue.lease!)}</span>
                  </Show>
                </div>
              </article>
            )}</For>
          </section>

          <section class="card" aria-labelledby="detail-title">
            <h2 id="detail-title">问题详情与状态流转</h2>
            <Show when={selected()} fallback={<p role="status">暂无审计问题。</p>}>{(_) => {
              const issue = selected()!;
              const claim = claimState(issue);
              const err = actionError();
              return <>
                <h3>{issue.title}</h3>
                <p><strong>复现步骤：</strong>{issue.steps}</p>
                <p><strong>修复记录：</strong>{issue.fixNote || '尚未填写'}</p>
                <p><strong>复测记录：</strong>{issue.retestNote || '尚未填写'}</p>

                <Show when={err && err.issueId === issue.id}>
                  <p class="error" role="alert" style="background:#fdecea;border:1px solid #f5c6c0;border-radius:8px;padding:8px 10px;margin:8px 0">
                    {err!.message}（可直接重试，不会重复计数）
                  </p>
                </Show>

                <Show when={issue.assignment}>
                  <div class="card" style="background:#fff8e1;border-color:#f0e0a0;margin:10px 0">
                    <strong>待移交确认</strong>
                    <p>协调员 {issue.assignment!.assignedByName} 指派 {issue.assignment!.assignedToName} 接管本问题；原处理人 {issue.lease?.handlerName ?? '—'} 的草稿已转为待移交。</p>
                    <Show when={issue.assignment!.assignedToId === currentUser().id && !isCoordinator()}
                      fallback={<p>等待 {issue.assignment!.assignedToName} 确认吸收或退回。</p>}>
                      <p>你是被指派的新处理人：确认后吸收原草稿并入修复记录并开始处理，也可退回本次指派。</p>
                      <div role="group" aria-label="移交确认操作">
                        <button onClick={() => absorbAssignment(issue)}>吸收草稿并接管</button>{' '}
                        <button class="secondary" onClick={() => returnAssignment(issue)}>退回指派</button>
                      </div>
                    </Show>
                  </div>
                </Show>

                <Show when={issue.pendingAssignment && !issue.assignment}>
                  <div class="card" style="background:#fdecea;border-color:#f5c6c0;margin:10px 0">
                    <strong>阻断问题 · 等待协调员指派</strong>
                    <p>原处理人 {issue.lease?.handlerName} 的租约已到期。按规定阻断问题不自动换人，需由协调员指派后才能接管。</p>
                    <Show when={isCoordinator()} fallback={<p>当前为审计员身份，无法指派；请切换为协调员身份操作。</p>}>
                      <label>指派给
                        <select aria-label="指派审计员" value={assignTarget()[issue.id] ?? ''}
                          onChange={(event) => setAssignTarget({ ...assignTarget(), [issue.id]: event.currentTarget.value })}>
                          <option value="">选择审计员</option>
                          <For each={AUDITORS}>{(auditor) => <option value={auditor.id}>{auditor.name}</option>}</For>
                        </select>
                      </label>
                      <button disabled={!assignTarget()[issue.id]} onClick={() => assignIssue(issue)}>确认指派</button>
                    </Show>
                  </div>
                </Show>

                <Show when={!issue.assignment && !issue.pendingAssignment}>
                  <Show when={issue.lease?.status === 'active'} fallback={
                    <div style="margin:10px 0">
                      <p>当前无人处理，问题处于待分诊状态。</p>
                      <Show when={!isCoordinator()} fallback={<p>协调员身份不能认领，请切换为审计员。</p>}>
                        <button onClick={() => claimIssue(issue)}>开始处理（认领租约，时长 {LEASE_DURATION_MS / 60_000} 分钟）</button>
                      </Show>
                    </div>
                  }>
                    <Show when={claim === 'mine'} fallback={
                      <div class="card" style="background:#eef6f6;margin:10px 0">
                        <p><strong>该问题正由 {issue.lease!.handlerName} 处理中</strong> · 租约剩余 {formatRemaining(issue.lease!)}（他人提交状态修改将被拒绝并返回当前处理人）</p>
                        <p><strong>处理草稿：</strong>{issue.draft || '—'}</p>
                      </div>
                    }>
                      <div class="card" style="background:#eefaf8;margin:10px 0">
                        <p><strong>你正在处理本问题</strong> · 租约剩余 {formatRemaining(issue.lease!)}，到期后问题回到待分诊{issue.severity === 'critical' ? '（阻断问题到期需协调员指派）' : ''}。</p>
                        <label>处理草稿（仅本人可见，提交状态修改时自动续期）
                          <textarea rows={3} value={issue.draft ?? ''} onInput={(event) => saveDraft(issue, event.currentTarget.value)}
                            placeholder="记录分诊要点，租约移交时随草稿一并交接" />
                        </label>
                        <button class="secondary" onClick={() => releaseIssue(issue)}>释放租约（停止处理）</button>
                      </div>
                    </Show>
                  </Show>
                </Show>

                <div role="group" aria-label="问题状态操作">
                  <button onClick={() => performAction(issue, { status: 'triaged' }, '完成分诊，确认问题有效')}>确认问题</button>{' '}
                  <button onClick={() => performAction(issue, { status: 'fixing', fixNote: '修复进行中，等待提交复测版本' }, '开发人员开始修复')}>开始修复</button>{' '}
                  <button onClick={() => performAction(issue, { status: 'verifying' }, '开发人员提交修复，进入复测')}>提交复测</button>{' '}
                  <button onClick={() => performAction(issue, { status: 'closed', retestNote: '键盘、读屏和错误提示均已通过' }, '复测通过并关闭问题')}>复测通过</button>{' '}
                  <button class="danger" onClick={() => performAction(issue, { status: 'reopened', retestNote: '焦点顺序仍不正确' }, '复测失败并重新打开')}>复测失败</button>
                </div>
                <hr />
                <label>合并到主问题<select value={mergeInto()} onChange={(event) => setMergeInto(event.currentTarget.value)}><option value="">选择问题</option><For each={state.issues.filter((item) => item.id !== issue.id && !item.canonicalId)}>{(item) => <option value={item.id}>{item.title}</option>}</For></select></label>
                <button disabled={!mergeInto()} onClick={mergeDuplicate}>确认重复合并</button>
              </>;
            }}</Show>
          </section>
        </div>

        <Show when={isCoordinator()}>
          <section class="card" aria-labelledby="assign-queue-title" style="margin-top:18px">
            <h2 id="assign-queue-title">阻断问题指派队列（协调员）</h2>
            <For each={state.issues.filter((issue) => issue.pendingAssignment && !issue.assignment)}>{(issue) => (
              <article class="issue">
                <h3>{issue.title} <span class="badge" style="background:#fdecea;color:#b42318">阻断</span></h3>
                <div class="meta">
                  <span>原处理人：{issue.lease?.handlerName ?? '—'}</span>
                  <span>租约到期：{issue.lease ? new Date(issue.lease.expiresAt).toLocaleString() : '—'}</span>
                  <span>待移交草稿：{issue.draft ? '有' : '无'}</span>
                </div>
                <label style="margin-top:8px">指派给
                  <select aria-label="指派审计员" value={assignTarget()[issue.id] ?? ''}
                    onChange={(event) => setAssignTarget({ ...assignTarget(), [issue.id]: event.currentTarget.value })}>
                    <option value="">选择审计员</option>
                    <For each={AUDITORS}>{(auditor) => <option value={auditor.id}>{auditor.name}</option>}</For>
                  </select>
                </label>
                <button style="margin-top:8px" disabled={!assignTarget()[issue.id]} onClick={() => assignIssue(issue)}>确认指派</button>
              </article>
            )}</For>
            <Show when={!state.issues.some((issue) => issue.pendingAssignment && !issue.assignment)}>
              <p role="status">暂无待指派的阻断问题。</p>
            </Show>
          </section>
        </Show>

        <div class="grid" style="margin-top:18px">
          <section class="card">
            <h2>新建审计问题</h2>
            <AuditForm onSubmit={createIssue} style="margin-top:12px">
              <AuditField name="title">{ (field, props) => <label>问题标题<input id="issue-title" {...props} value={field.value} aria-invalid={field.error ? 'true' : undefined} aria-describedby={field.error ? 'title-error' : undefined} /><Show when={field.error}><p class="error" id="title-error" role="alert">{field.error}</p></Show></label> }</AuditField>
              <AuditField name="flow">{ (field, props) => <label>业务流程<input {...props} value={field.value} /></label> }</AuditField>
              <AuditField name="steps">{ (field, props) => <label>复现步骤<textarea {...props} rows={4} value={field.value} /></label> }</AuditField>
              <AuditField name="impactGroup">{ (field, props) => <label>影响人群<select {...props} value={field.value}><option>键盘与读屏用户</option><option>低视力用户</option><option>认知障碍用户</option><option>行动障碍用户</option></select></label> }</AuditField>
              <AuditField name="severity">{ (field, props) => <label>严重程度<select {...props} value={field.value}><option value="critical">阻断</option><option value="serious">严重</option><option value="moderate">中等</option><option value="minor">轻微</option></select></label> }</AuditField>
              <button type="submit">创建问题</button>
            </AuditForm>
          </section>

          <section class="card tabs">
            <h2>{t()('events')}</h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List><Tabs.Trigger value="activity">操作记录</Tabs.Trigger><Tabs.Trigger value="keyboard">键盘说明</Tabs.Trigger></Tabs.List>
              <Tabs.Content value="activity"><div class="timeline" aria-live="polite"><For each={state.events.slice(0, 12)}>{(event) => <div style="margin-bottom:12px"><strong>{new Date(event.at).toLocaleString()}</strong><div>{event.message}</div></div>}</For></div></Tabs.Content>
              <Tabs.Content value="keyboard"><ul><li><kbd>N</kbd>：聚焦新建问题标题</li><li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>：按可见顺序移动焦点</li><li><kbd>Ctrl+Enter</kbd>：表单支持键盘提交</li><li>所有错误消息使用 <code>role="alert"</code> 并通过描述关系关联字段</li></ul></Tabs.Content>
            </Tabs.Root>
          </section>
        </div>
      </main>
    </>
  );
}
