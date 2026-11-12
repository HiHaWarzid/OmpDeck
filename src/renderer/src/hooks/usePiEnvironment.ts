import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import type {
  AppSettings,
  NpmAvailabilityResult,
  PiInstallExecResult,
  PiInstallStatus,
} from "../../../shared/types";

/**
 * pi 环境（安装 / 路径 / npm / 镜像）的状态机 —— 桌面端「Pi 环境模块」。
 *
 * 迁出原因：环境检测、自定义路径校验、npm 安装流程合计 17 个状态，原来内联在
 * App() 里，规则（首次启动检测成功后落盘一次、手动校验成功 3s 后关弹框、
 * 用户手动改过路径后不再自动回填、安装命令与镜像开关必须同步改写）只能整机手点验证。
 *
 * 依赖全部注入：`api` 负责进程侧检测，`onSettingsSaved` 回灌设置（piEnvironmentChecked /
 * customPiPath 由本模块写入），`showToast` 复用统一通知。这样 App 只剩接线，
 * 本模块可以单独用假 api 测。
 */

type PiEnvironmentApi = {
  pi: {
    check: () => Promise<PiInstallStatus>;
    checkCustom: (path: string) => Promise<PiInstallStatus>;
    checkNpm: () => Promise<NpmAvailabilityResult>;
    execInstall: (command: string) => Promise<PiInstallExecResult>;
  };
  settings: {
    get: () => Promise<AppSettings>;
    update: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  };
};

export interface PiEnvironmentDeps {
  api: PiEnvironmentApi;
  showToast: (message: string, duration?: number) => void;
  /** settings.update 的结果必须回灌 App 的 settings state（弹框/启动逻辑都读它）。 */
  onSettingsSaved: (next: AppSettings) => void;
  /**
   * 设置页内联检测失败时要让用户看到安装指引：App 用它关掉设置弹框，
   * 否则环境弹框会挂在设置弹框后面。
   */
  onInlineCheckFailed?: () => void;
}

export interface PiEnvironment {
  status: PiInstallStatus | null;
  checking: boolean;
  dialogOpen: boolean;
  customPath: string;
  customPathValidating: boolean;
  customPathResult: PiInstallStatus | null;
  npmAvailable: boolean | null;
  npmVersion: string | undefined;
  npmChecking: boolean;
  installCommand: string;
  installUseMirror: boolean;
  installExecuting: boolean;
  installResult: PiInstallExecResult | null;
  installCompleted: boolean;

  /** 检测环境；startup 通过后只落盘一次并自动关闭弹框。 */
  check: (source?: "startup" | "manual") => Promise<void>;
  /** 设置页内联复检：成功提示并落盘，失败弹环境弹框。 */
  checkInline: () => Promise<void>;
  /** 不弹框地刷新状态（如 WSL 配置切换后）。 */
  refreshStatus: () => Promise<void>;
  validateCustomPath: (options?: { closeDialogOnSuccess?: boolean }) => Promise<void>;
  clearCustomPath: () => Promise<void>;
  checkNpm: () => Promise<void>;
  execInstallCommand: () => Promise<void>;
  setCustomPath: (path: string) => void;
  /** 设置加载完成后同步已保存路径：有保存值即视为已触碰，避免检测结果覆盖用户选择。 */
  adoptSavedPath: (savedPath: string) => void;
  setInstallCommand: (command: string) => void;
  toggleInstallMirror: () => void;
  closeDialog: () => void;
  recheck: () => Promise<void>;
}

const DEFAULT_INSTALL_COMMAND = "npm install -g @earendil-works/pi-coding-agent";
const CLOSE_DIALOG_DELAY_MS = 3_000;

export function usePiEnvironment(deps: PiEnvironmentDeps): PiEnvironment {
  const { api, showToast, onSettingsSaved, onInlineCheckFailed } = deps;

  const [status, setStatus] = useState<PiInstallStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [customPath, setCustomPathState] = useState("");
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const [customPathResult, setCustomPathResult] = useState<PiInstallStatus | null>(null);
  const [npmAvailable, setNpmAvailable] = useState<boolean | null>(null);
  const [npmVersion, setNpmVersion] = useState<string | undefined>(undefined);
  const [npmChecking, setNpmChecking] = useState(false);
  const [installCommand, setInstallCommand] = useState(DEFAULT_INSTALL_COMMAND);
  const [installUseMirror, setInstallUseMirror] = useState(false);
  const [installExecuting, setInstallExecuting] = useState(false);
  const [installResult, setInstallResult] = useState<PiInstallExecResult | null>(null);
  const [installCompleted, setInstallCompleted] = useState(false);

  /** 用户是否手动编辑/清除过自定义路径；置位后检测结果不再自动填充输入框 */
  const customPathTouchedRef = useRef(false);

  // 检测到 omp 且用户未编辑、无已保存路径时，把检测路径作为输入框初始值；
  // 否则 placeholder 里显示的检测路径容易让人误以为已填内容（校验/清除按钮却因空值禁用）。
  useEffect(() => {
    if (
      !customPathTouchedRef.current &&
      !customPath &&
      status?.installed &&
      status.command
    ) {
      setCustomPathState(status.command);
    }
  }, [status, customPath]);

  /** 关闭弹框：清掉本次检测派生的临时结果，下次打开从干净状态开始。 */
  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    setCustomPathResult(null);
    setInstallResult(null);
    setInstallCompleted(false);
    setNpmAvailable(null);
  }, []);

  const check = useCallback(
    async (source: "startup" | "manual" = "manual") => {
      setChecking(true);
      setDialogOpen(true);
      try {
        const next = await api.pi.check();
        setStatus(next);
        if (next.installed && source === "startup") {
          // 首次启动检测通过后落盘,后续启动不再阻塞/打扰;用户仍可在设置里手动重新检测。
          onSettingsSaved(await api.settings.update({ piEnvironmentChecked: true }));
          window.setTimeout(() => setDialogOpen(false), CLOSE_DIALOG_DELAY_MS);
        }
        if (next.installed && source === "manual") {
          window.setTimeout(() => setDialogOpen(false), CLOSE_DIALOG_DELAY_MS);
        }
      } finally {
        setChecking(false);
      }
    },
    [api, onSettingsSaved],
  );

  const checkInline = useCallback(async () => {
    setChecking(true);
    setCustomPathResult(null);
    try {
      const next = await api.pi.check();
      setStatus(next);
      if (next.installed) {
        onSettingsSaved(await api.settings.update({ piEnvironmentChecked: true }));
        showToast(
          t("app.piCheckPassed", { value: next.command ?? next.version ?? "omp" }),
        );
      } else {
        /* 检测失败时弹出环境检测弹框，方便用户查看安装指引 */
        onInlineCheckFailed?.();
        setDialogOpen(true);
      }
    } finally {
      setChecking(false);
    }
  }, [api, onInlineCheckFailed, onSettingsSaved, showToast]);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.pi.check());
    } catch {
      // 静默刷新：调用方（设置变更后）不关心失败，下一次检测会再覆盖状态。
    }
  }, [api]);

  /**
   * 校验用户手动输入的 pi 路径。
   * 主进程执行 command --version 验证后,通过则自动保存到 settings.customPiPath,
   * 之后新建/重启 agent 时 PiProcess 会优先使用自定义路径。
   */
  const validateCustomPath = useCallback(
    async (options: { closeDialogOnSuccess?: boolean } = {}) => {
      const path = customPath.trim();
      if (!path) return;
      setCustomPathValidating(true);
      setCustomPathResult(null);
      try {
        const result = await api.pi.checkCustom(path);
        setCustomPathResult(result);
        if (result.installed) {
          // 主进程会保存 PiLocator 归一化后的路径;这里重新读取,确保 UI 展示的是实际使用路径。
          const updated = await api.settings.get();
          onSettingsSaved(updated);
          setCustomPathState(updated.customPiPath ?? result.command ?? path);
          setStatus(result);
          showToast(
            t("app.piPathSaved", {
              path: result.command ?? updated.customPiPath ?? path,
            }),
          );
          if (options.closeDialogOnSuccess) {
            // 启动检测弹窗场景下保持原有成功后自动关闭体验;设置页内校验不关闭设置窗口。
            window.setTimeout(() => setDialogOpen(false), CLOSE_DIALOG_DELAY_MS);
          }
        } else {
          showToast(
            t("app.piPathValidateFailed", {
              error: result.error ?? t("environment.unableToRun"),
            }),
          );
        }
      } finally {
        setCustomPathValidating(false);
      }
    },
    [api, customPath, onSettingsSaved, showToast],
  );

  const clearCustomPath = useCallback(async () => {
    // 用户明确清除：标记为已触碰，避免后续检测结果自动回填
    customPathTouchedRef.current = true;
    onSettingsSaved(await api.settings.update({ customPiPath: "" }));
    setCustomPathState("");
    setCustomPathResult(null);
    showToast(t("app.piPathCleared"));
    setStatus(await api.pi.check());
  }, [api, onSettingsSaved, showToast]);

  const adoptSavedPath = useCallback((savedPath: string) => {
    customPathTouchedRef.current = Boolean(savedPath);
    setCustomPathState(savedPath);
  }, []);

  const setCustomPath = useCallback((path: string) => {
    customPathTouchedRef.current = true;
    setCustomPathState(path);
    setCustomPathResult(null);
  }, []);

  /** 检查 npm 是否可用（环境弹框里安装面板的入口条件）。 */
  const checkNpm = useCallback(async () => {
    setNpmChecking(true);
    try {
      const result = await api.pi.checkNpm();
      setNpmAvailable(result.available);
      setNpmVersion(result.version);
    } finally {
      setNpmChecking(false);
    }
  }, [api]);

  /** 执行安装命令的 handler：退出码 0 视为安装成功。 */
  const execInstallCommand = useCallback(async () => {
    const cmd = installCommand.trim();
    if (!cmd) return;
    setInstallExecuting(true);
    setInstallResult(null);
    setInstallCompleted(false);
    try {
      const result = await api.pi.execInstall(cmd);
      setInstallResult(result);
      if (result.success && result.exitCode === 0) setInstallCompleted(true);
    } finally {
      setInstallExecuting(false);
    }
  }, [api, installCommand]);

  const setInstallCommandAndReset = useCallback((command: string) => {
    setInstallCommand(command);
    setInstallResult(null);
    setInstallCompleted(false);
  }, []);

  // 镜像开关与命令文本必须同步改写：命令里是否带 --registry 是用户可见的事实，
  // 单切开关不改文本会出现「勾着镜像但实际直连」的假象。
  const toggleInstallMirror = useCallback(() => {
    setInstallUseMirror((prev) => {
      if (prev) {
        setInstallCommand((cmd) =>
          cmd.replace(/\s+--registry=https:\/\/registry\.npmmirror\.com/g, ""),
        );
      } else {
        setInstallCommand((cmd) =>
          cmd.includes("--registry=")
            ? cmd
            : cmd + " --registry=https://registry.npmmirror.com",
        );
      }
      return !prev;
    });
    setInstallResult(null);
    setInstallCompleted(false);
  }, []);

  /** 环境弹框「重新检测」：清空本次安装面板的临时状态后再检测。 */
  const recheck = useCallback(async () => {
    setCustomPathResult(null);
    setNpmAvailable(null);
    setNpmVersion(undefined);
    setInstallResult(null);
    setInstallCompleted(false);
    setInstallUseMirror(false);
    await check("manual");
  }, [check]);

  return {
    status,
    checking,
    dialogOpen,
    customPath,
    customPathValidating,
    customPathResult,
    npmAvailable,
    npmVersion,
    npmChecking,
    installCommand,
    installUseMirror,
    installExecuting,
    installResult,
    installCompleted,
    check,
    checkInline,
    refreshStatus,
    validateCustomPath,
    clearCustomPath,
    checkNpm,
    execInstallCommand,
    setCustomPath,
    adoptSavedPath,
    setInstallCommand: setInstallCommandAndReset,
    toggleInstallMirror,
    closeDialog,
    recheck,
  };
}
