import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Two type-only imports, both erased: the shape of a refusal, and the shape of
// the translator the slot machinery hands the pane.
import type { HostReason } from '../shared/reasons'
import type { Translate } from './core/embedded-view'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    iamMiningView: keyof typeof zh
  }
}

/** Simplified Chinese -- the wording this pane already had, unchanged. */
export const zh = {
  // The preview's title, in the document pane's tab bar.
  previewTitleDrawing: '绘图 2D',
  previewTitleMining: '矿山 3D',

  // Starting up, and the three ways a view can fail to.
  preparing: '正在准备视图…',
  failedNoAdapter:
    '预览无法启动：宿主浏览器没有可用的 WebGPU 适配器（硬件加速被关闭或屏蔽，也没有软件回退）。'
    + '桌面端请在启动参数里打开 Vulkan（--enable-features=Vulkan）；或改用 Web 端预览，浏览器默认已开启。',
  failedNoWebGpu: '预览无法启动：这个浏览器上下文没有 WebGPU（不是安全上下文，或浏览器版本过旧）。',
  failedOther: '预览无法启动：{problem}',
  opened: '{name} 已打开',
  opening: '正在打开 {name}…',
  startupTimeout:
    '{name} 在 {seconds} 秒内既没有报错也没有给出画面。'
    + '请查看渲染进程控制台（IAX 视图的诊断写在里面），以及 WebGPU 适配器是否可用。',

  // Browse / Edit.
  modeBrowse: '浏览',
  modeEdit: '编辑',
  switchingToEdit: '切换到编辑模式…',
  switchingToBrowse: '切换到浏览模式…',
  switchedToEdit: '已切换到编辑模式',
  switchedToBrowse: '已切换到浏览模式',

  // The native editor.
  nativeBrowse: '在原生中浏览',
  nativeEdit: '在原生中编辑',
  nativeLaunchingEdit: '正在启动原生编辑器（编辑）…',
  nativeLaunchingBrowse: '正在启动原生浏览器…',
  nativeOpenedEdit: '已在独立窗口中打开（编辑）。保存后这里会提示刷新预览。',
  nativeOpenedBrowse: '已在独立窗口中打开（浏览）。保存后这里会提示刷新预览。',
  nativeLaunchFailed: '无法启动原生编辑器：{reason}',
  refusalUnknown: '原生编辑器不可用。',
  refusalDesktopOnlyLaunch: 'Web 端无法启动用户本机的原生程序。请下载文件后在本地打开。',
  // The refusals the host can name, in the order `shared/reasons.ts` lists
  // them.  These used to be prose written by the host half, which is a Node
  // process with no idea what language this page is in -- see that file.
  refusalDesktopOnly: '更强大的可视化及编辑功能请安装桌面端。',
  refusalNoBinDir:
    '没有配置原生编辑器目录。请给插件设置 nativeBinDir，或设置环境变量 IAM_NATIVE_DIR'
    + '指向包含 IamDrawing / IamMining 的目录。',
  refusalNoFontsDir: '没有配置字体目录。请给插件设置 fontsDir，或设置环境变量 IAM_FONTS_DIR（SHX 字体所在目录）。',
  refusalNoExecutable: '没有找到原生编辑器可执行文件：{detail}',
  refusalNoEventPort: '本机事件端口无法打开。',
  refusalNotStarted: '原生编辑器没有启动。',
  refusalAlreadyOpen: '这个文档已经在原生窗口中打开；请先关闭那个窗口。',
  refusalNoViewState: '这个会话还没有视图状态。',
  refusalNoAgent: '这个会话当前没有可唤醒的智能体。',
  nativeConnected: '原生编辑器已连接',

  // Waking the agent.
  askSelection: '让智能体分析选择',
  askEdits: '让智能体检查修改',
  askedSelection: '已请智能体分析当前选择。',
  askedEdits: '已请智能体检查最近修改。',
  wakeFailed: '无法通知智能体：{reason}',

  // The card a "显示…" call leaves in the conversation.  Its data is the tool
  // result's presentation metadata, which is why these words are the pane's and
  // not MiningRepository's: the tool is a host process that knows nothing about
  // what language this page is in.
  showPreparing: '正在定位选择…',
  showUntitled: '选择集',
  showRefused: '这个选择无法显示',
  showOpen: '在面板中打开',
  showNative: '已在原生编辑器中打开',

  // The status line.
  noSelection: '未选择',
  selectionCount: '已选 {count}',
  selectionCountMore: '已选 {count}+',
  selectionCountPartial: '已选 {count}…',
  unsavedCount: '{count} 处未保存',
  droppedFacts: '有 {count} 条事件未上报',

  // Refreshing from the file.
  reloading: '正在重新读取文件…',
  reloadFailed: '无法重新读取文件：{status}',
  reloaded: '{name} 已刷新',
  // The one thing this pane has to say that the Drawing pane does not: a
  // columnar store the browser build cannot read at all.
  columnarStore: '{name} '
    + '无法在这个预览中打开。',
  columnarUseNative: '请使用“在原生中浏览”或“在原生中编辑”，在本机打开它。',
  columnarUseNativeElsewhere: '请到安装了本平台原生编辑器的机器上打开。',
  columnarReady: '可以按需在原生窗口中打开。',
  columnarOpenedBrowse: '已在独立窗口中打开（浏览）。',
  columnarOpenedEdit: '已在独立窗口中打开（编辑）。',
  conflictNotice: '预览中还有未保存的修改，刷新会丢弃它们。',
  staleNotice: '文件已被原生编辑器更新，预览显示的是打开时的版本。',
  refreshPreview: '刷新预览',

  // The event channel.
  channelNotEstablished: '事件通道未建立：{reason}',
  channelNotRestored: '预览重新挂载后未能重新建立事件通道：{reason}',
  channelCannotWakeAgent: '事件通道未建立，无法通知智能体。',
  channelCannotLaunch: '事件通道未建立。',
  queueFull: '视图事件队列已满，有 {count} 条事件未能上报；这一情况会随下一次上报一起交给会话。',
  deliveryFailed:
    '视图事件暂时无法送达会话（{reason}）。已保留 {count} 条事件，并会继续重试。',
  reauthorisationFailed: '视图事件通道需要重新授权，但续期失败：{reason}',
  batchRejected: '视图事件批次被拒绝（{status}），改为小批重发。',
  eventRejected: '视图事件未被接受（{status}）：{detail}',
  sessionRejected: '会话拒绝了 {count} 条视图事件，详见状态行。',
  undeliverable: '视图事件未能送达会话：{reason}',
} satisfies Record<string, string>

/** English, checked complete against the Chinese key set. */
export const en = {
  previewTitleDrawing: 'Drawing 2D',
  previewTitleMining: 'Mining 3D',

  preparing: 'Preparing the view…',
  failedNoAdapter:
    'The preview could not start: the hosting browser has no usable WebGPU adapter '
    + '(hardware acceleration is off or blocked, and there is no software fallback). '
    + 'On the desktop carrier, enable Vulkan in the launch options (--enable-features=Vulkan); '
    + 'or use the Web carrier, where browsers enable it by default.',
  failedNoWebGpu:
    'The preview could not start: this browser context has no WebGPU '
    + '(it is not a secure context, or the browser is too old).',
  failedOther: 'The preview could not start: {problem}',
  opened: '{name} is open',
  opening: 'Opening {name}…',
  startupTimeout:
    '{name} neither reported an error nor produced a picture within {seconds} seconds. '
    + 'Check the renderer console (the IAX view writes its diagnostics there) and whether '
    + 'a WebGPU adapter is available.',

  modeBrowse: 'Browse',
  modeEdit: 'Edit',
  switchingToEdit: 'Switching to Edit…',
  switchingToBrowse: 'Switching to Browse…',
  switchedToEdit: 'Switched to Edit',
  switchedToBrowse: 'Switched to Browse',

  nativeBrowse: 'Browse natively',
  nativeEdit: 'Edit natively',
  nativeLaunchingEdit: 'Starting the native editor (Edit)…',
  nativeLaunchingBrowse: 'Starting the native browser…',
  nativeOpenedEdit: 'Opened in its own window (Edit). Saving there will offer to refresh this preview.',
  nativeOpenedBrowse: 'Opened in its own window (Browse). Saving there will offer to refresh this preview.',
  nativeLaunchFailed: 'The native editor could not be started: {reason}',
  refusalUnknown: 'The native editor is unavailable.',
  refusalDesktopOnlyLaunch:
    'The Web carrier cannot start a program on your own machine. Download the file and open it locally.',
  refusalDesktopOnly: 'Richer visualisation and editing are in the desktop app.',
  refusalNoBinDir:
    'No native editor directory is configured. Set the plugin\'s nativeBinDir, or IAM_NATIVE_DIR, '
    + 'to the directory holding IamDrawing / IamMining.',
  refusalNoFontsDir:
    'No font directory is configured. Set the plugin\'s fontsDir, or IAM_FONTS_DIR, to the '
    + 'directory holding the SHX fonts.',
  refusalNoExecutable: 'The native editor executable was not found: {detail}',
  refusalNoEventPort: 'The local event port could not be opened.',
  refusalNotStarted: 'The native editor did not start.',
  refusalAlreadyOpen: 'This document is already open in the native window; close that window first.',
  refusalNoViewState: 'This session has no view state yet.',
  refusalNoAgent: 'This session is not holding an agent that can be woken right now.',
  nativeConnected: 'Native editor connected',

  askSelection: 'Have the agent analyse the selection',
  askEdits: 'Have the agent review the edits',
  askedSelection: 'Asked the agent to analyse the current selection.',
  askedEdits: 'Asked the agent to review the recent edits.',
  wakeFailed: 'The agent could not be notified: {reason}',

  showPreparing: 'Resolving the selection…',
  showUntitled: 'Selection',
  showRefused: 'This selection could not be shown',
  showOpen: 'Open in panel',
  showNative: 'Opened in the native editor',

  noSelection: 'Nothing selected',
  selectionCount: '{count} selected',
  selectionCountMore: '{count}+ selected',
  selectionCountPartial: '{count}… selected',
  unsavedCount: '{count} unsaved',
  droppedFacts: '{count} events were not reported',

  reloading: 'Reading the file again…',
  reloadFailed: 'The file could not be read again: {status}',
  reloaded: '{name} was refreshed',
  columnarStore: '{name} '
    + 'cannot be opened in this preview.',
  columnarUseNative: 'Use “Browse natively” or “Edit natively” to open it on this machine.',
  columnarUseNativeElsewhere: 'Open it on a machine with this platform’s native editor installed.',
  columnarReady: 'Ready to open in the native window.',
  columnarOpenedBrowse: 'Opened in its own window (Browse).',
  columnarOpenedEdit: 'Opened in its own window (Edit).',
  conflictNotice: 'The preview holds unsaved edits; refreshing will discard them.',
  staleNotice: 'The native editor has updated this file; the preview shows the version it was opened with.',
  refreshPreview: 'Refresh the preview',

  channelNotEstablished: 'The event channel was not established: {reason}',
  channelNotRestored: 'The event channel was not re-established after the preview remounted: {reason}',
  channelCannotWakeAgent: 'The event channel is not established, so the agent cannot be notified.',
  channelCannotLaunch: 'The event channel is not established.',
  queueFull:
    'The view event queue is full and {count} events could not be reported; the session will be told '
    + 'along with the next report.',
  deliveryFailed:
    'View events cannot reach the session right now ({reason}). {count} are being kept and will be retried.',
  reauthorisationFailed: 'The view event channel needs re-authorising, and the renewal failed: {reason}',
  batchRejected: 'The view event batch was refused ({status}); resending it in smaller batches.',
  eventRejected: 'The view events were not accepted ({status}): {detail}',
  sessionRejected: 'The session refused {count} view events; see the status line.',
  undeliverable: 'View events could not reach the session: {reason}',
} satisfies Record<keyof typeof zh, string>

/** The namespace this file's dictionaries are registered under. */
export const NAMESPACE = 'iamMiningView'

/**
 * Which of this pane's sentences says each refusal the host can name.
 *
 * THE TABLE IS EXHAUSTIVE ON PURPOSE. `HostReason` is a closed union, so a
 * name the host learns to send and the pane never learns to say is a type error
 * at the one place that can see both halves at once. That check lives in an
 * editor rather than in the build -- neither half is type-checked when it is
 * emitted -- which is why the fallback below is not decoration: the two halves
 * ship separately, and a bundle older than its host is the ordinary case.
 */
const HOST_REASON_KEYS: Record<HostReason, keyof typeof zh> = {
  desktopOnlyLaunch: 'refusalDesktopOnlyLaunch',
  desktopOnly: 'refusalDesktopOnly',
  noBinDir: 'refusalNoBinDir',
  noFontsDir: 'refusalNoFontsDir',
  noExecutable: 'refusalNoExecutable',
  noEventPort: 'refusalNoEventPort',
  notStarted: 'refusalNotStarted',
  alreadyOpen: 'refusalAlreadyOpen',
  noViewState: 'refusalNoViewState',
  noAgent: 'refusalNoAgent',
}

/** What the host said, when it is a refusal this build has words for. */
export interface HostAnswer {
  readonly code?: string
  readonly detail?: string
  readonly reason?: string
}

/** The sentence for a code this build knows, or null for one it does not. */
function refusalSentence(t: Translate, answer: HostAnswer): string | null {
  const key = answer.code === undefined ? undefined : HOST_REASON_KEYS[answer.code as HostReason]
  if (key === undefined) return null
  return answer.detail === undefined ? t(key) : t(key, { detail: answer.detail })
}

/**
 * The host's refusal, in the user's language.
 *
 * `reason` is the fallback and it is the host's own text: worse than a
 * translation, and far better than the blank a pane that only knew codes would
 * show for a name it had never heard of. The generic sentence covers a host that
 * sent neither -- which is a pane talking to an older host half.
 */
export function refusalText(t: Translate, answer: HostAnswer): string {
  return refusalSentence(t, answer) ?? answer.reason ?? t('refusalUnknown')
}

/**
 * The same refusal, in the shape a failed ACTION needs.
 *
 * A named refusal already says what is wrong and does not want a wrapper around
 * it. The wrapper is for the other kind: raw text such as `EACCES` says nothing
 * about what was being attempted until the sentence around it does.  `failureKey`
 * is the caller's own verb -- `nativeLaunchFailed`, `wakeFailed` -- because that
 * is the one part of the sentence this file cannot know.
 */
export function actionFailureText(t: Translate, failureKey: string, answer: HostAnswer): string {
  return refusalSentence(t, answer) ?? t(failureKey, { reason: answer.reason ?? 'unknown' })
}
