import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import type {
  AppUpdateDownloadProgress,
  AppUpdateInfo,
  PiCliUpdateResult,
  PiUpdateCheckResult,
} from "../../../shared/types";

/**
 * 应用更新与 pi CLI 更新的状态机（桌面端「更新中心」深模块）。
 *
 * 迁出原因：这两套流程合计 11 个 useState + 5 个异步动作 + 1 个定时器，原来内联在
 * App() 8k 行函数里。它们的规则（自动检查的节流、失败只对用户可见的手动检查报错、
 * 下载进度以主进程推送为准、pi 更新后要重跑环境检测）没有测试入口——只能整机手点。
 *
 * 接口只暴露「状态 + 动作 + 进度入口」：
 * - 主进程的 `onUpdateProgress` 订阅生命周期仍在 App 的挂载 effect 里（与其它
 *   监听器同处），回调把进度交给 `ingestProgress`，本模块不自己订阅，避免重复监听；
 * - 自动检查（启动 5s 后 + 每 6h）由本模块内的 effect 负责，`disableUpdateCheck`
 *   翻转即启停；
 * - 依赖（api / toast / releasesUrl / pi 更新后的环境复检）全部注入，测试可替换。
 */

type UpdateCenterApi = {
  app: {
    checkUpdate: () => Promise<AppUpdateInfo>;
    downloadUpdate: (asset: AppUpdateAssetLike) => Promise<{ filePath: string }>;
    installUpdate: (filePath: string) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };
  pi: {
    checkUpdate: () => Promise<PiUpdateCheckResult>;
    update: () => Promise<PiCliUpdateResult>;
  };
};

/** 仅用于回调参数类型，避免把整个 shared API 形状耦合进来。 */
type AppUpdateAssetLike = NonNullable<AppUpdateInfo["recommendedAsset"]>;

export interface UpdateCenterDeps {
  api: UpdateCenterApi;
  /** 复用 App 的统一通知（sonner）；默认时长 3500ms。 */
  showToast: (message: string, duration?: number) => void;
  /** 用户关闭了版本检测：自动检查与手动检查都直接跳过。 */
  disableUpdateCheck: boolean;
  /** 无推荐安装包时跳转的 release 页面地址。 */
  releasesUrl: string;
  /** pi CLI 升级成功后回调（App 侧用于重跑 pi 环境检测）。 */
  onPiUpdated?: () => Promise<void> | void;
}

export interface AppUpdateState {
  info: AppUpdateInfo | null;
  error: string | null;
  checking: boolean;
  downloading: boolean;
  progress: AppUpdateDownloadProgress | null;
  downloadedPath: string | null;
  /** 手动检查且已是最新时显示的版本号（驱动「已是最新」弹框）。 */
  upToDateVersion: string | null;
}

export interface PiUpdateState {
  updating: boolean;
  checking: boolean;
  lastCheck: PiUpdateCheckResult | null;
  lastResult: PiCliUpdateResult | null;
}

export interface UpdateCenter {
  app: AppUpdateState;
  pi: PiUpdateState;
  /** 手动/自动检查应用更新。自动源静默失败，手动源给出 toast 与错误态。 */
  checkAppUpdate: (source?: "auto" | "manual") => Promise<void>;
  /** 下载推荐安装包；无推荐包时打开 release 页面（保留旧行为）。 */
  downloadAppUpdate: () => Promise<void>;
  installDownloadedAppUpdate: () => Promise<void>;
  /** 主进程下载进度入口（App 的 onUpdateProgress 订阅回调调用）。 */
  ingestAppUpdateProgress: (progress: AppUpdateDownloadProgress) => void;
  /** 启动后台检查 pi CLI 更新：有更新只提示一次，失败静默。 */
  checkPiCliUpdateOnStartup: () => Promise<void>;
  checkPiCliUpdate: () => Promise<void>;
  updatePiCli: () => Promise<void>;
  /** 关闭「有新版本」/「下载失败」/「已是最新」弹框时清对应状态。 */
  dismissAppUpdateInfo: () => void;
  dismissAppUpdateError: () => void;
  dismissUpToDate: () => void;
}

const AUTO_CHECK_INTERVAL_MS = 1000 * 60 * 60 * 6;
const AUTO_CHECK_DELAY_MS = 5_000;

export function useUpdateCenter(deps: UpdateCenterDeps): UpdateCenter {
  const { api, showToast, disableUpdateCheck, releasesUrl, onPiUpdated } = deps;
  const [app, setApp] = useState<AppUpdateState>({
    info: null,
    error: null,
    checking: false,
    downloading: false,
    progress: null,
    downloadedPath: null,
    upToDateVersion: null,
  });
  const [pi, setPi] = useState<PiUpdateState>({
    updating: false,
    checking: false,
    lastCheck: null,
    lastResult: null,
  });

  // 检查在途守卫用 ref：定时器与手动点击可能在同一帧先后触发，
  // 依赖 state 闭包会让第二个调用漏过守卫、并发打两次接口。
  const checkingRef = useRef(false);

  const patchApp = useCallback((patch: Partial<AppUpdateState>) => {
    setApp((current) => ({ ...current, ...patch }));
  }, []);

  const patchPi = useCallback((patch: Partial<PiUpdateState>) => {
    setPi((current) => ({ ...current, ...patch }));
  }, []);

  const checkAppUpdate = useCallback(
    async (source: "auto" | "manual" = "manual") => {
      if (disableUpdateCheck) return;
      if (checkingRef.current) return;
      checkingRef.current = true;
      patchApp({ checking: true });
      try {
        const next = await api.app.checkUpdate();
        if (next.hasUpdate) {
          patchApp({ info: next });
        } else if (source === "manual") {
          patchApp({ upToDateVersion: next.currentVersion });
          showToast(t("app.latestVersionNotice", { version: next.currentVersion }));
        }
      } catch (error) {
        // 自动检查失败不打扰用户；手动检查给出可读错误并留下错误态。
        if (source === "manual") {
          const message = error instanceof Error ? error.message : String(error);
          showToast(t("app.updateFailedNotice", { error: message }));
          patchApp({ error: message });
          showToast(t("app.updateFailed"));
        }
      } finally {
        checkingRef.current = false;
        patchApp({ checking: false });
      }
    },
    [api, disableUpdateCheck, patchApp, showToast],
  );

  const downloadAppUpdate = useCallback(async () => {
    const asset = app.info?.recommendedAsset;
    if (!asset) {
      await api.app.openExternal(app.info?.releaseUrl ?? releasesUrl);
      return;
    }
    patchApp({
      downloading: true,
      downloadedPath: null,
      progress: {
        assetName: asset.name,
        receivedBytes: 0,
        totalBytes: asset.size,
        percent: 0,
        state: "downloading",
      },
    });
    try {
      const result = await api.app.downloadUpdate(asset);
      patchApp({ downloadedPath: result.filePath });
      showToast(t("update.downloadCompleted"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      patchApp({ error: message });
      showToast(t("update.downloadFailed"));
    } finally {
      patchApp({ downloading: false });
    }
  }, [api, app.info, patchApp, releasesUrl, showToast]);

  const installDownloadedAppUpdate = useCallback(async () => {
    if (!app.downloadedPath) return;
    await api.app.installUpdate(app.downloadedPath);
  }, [api, app.downloadedPath]);

  const ingestAppUpdateProgress = useCallback(
    (progress: AppUpdateDownloadProgress) => {
      // 进度以主进程推送为准：completed 交付最终路径，failed 落错误态并解锁下载按钮。
      const patch: Partial<AppUpdateState> = { progress };
      if (progress.state === "completed") {
        patch.downloading = false;
        patch.downloadedPath = progress.filePath ?? null;
      } else if (progress.state === "failed") {
        patch.downloading = false;
        patch.error = progress.error ?? t("update.downloadFailed");
      }
      patchApp(patch);
    },
    [patchApp],
  );

  const checkPiCliUpdateOnStartup = useCallback(async () => {
    if (disableUpdateCheck) return;
    try {
      const result = await api.pi.checkUpdate();
      patchPi({ lastCheck: result });
      if (result.hasUpdate) {
        // 启动后后台提醒即可，不阻塞主界面；低版本 pi 可能缺少新版协议/工具能力。
        showToast(t("settings.piUpdateStartupNotice"), 6500);
      }
    } catch {
      // 后台检查失败不打扰用户；设置页仍可手动检查并看到详细错误。
    }
  }, [api, disableUpdateCheck, patchPi, showToast]);

  const checkPiCliUpdate = useCallback(async () => {
    if (disableUpdateCheck) return;
    patchPi({ checking: true });
    try {
      const result = await api.pi.checkUpdate();
      patchPi({ lastCheck: result });
      showToast(
        result.error
          ? t("settings.piUpdateFailed", { error: result.error })
          : result.hasUpdate
            ? t("settings.piUpdateAvailable")
            : t("settings.piUpdateChecked"),
      );
    } finally {
      patchPi({ checking: false });
    }
  }, [api, disableUpdateCheck, patchPi, showToast]);

  const updatePiCli = useCallback(async () => {
    patchPi({ updating: true, lastResult: null });
    try {
      const result = await api.pi.update();
      patchPi({ lastResult: result });
      await onPiUpdated?.();
      // 升级后重新取一次版本信息：无论成功与否，设置页都应显示新的真实状态。
      const check = await api.pi.checkUpdate();
      patchPi({ lastCheck: check });
      showToast(result.updated ? t("settings.piUpdateDone") : t("settings.piUpdateChecked"));
    } catch (error) {
      showToast(
        t("settings.piUpdateFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      patchPi({ updating: false });
    }
  }, [api, onPiUpdated, patchPi, showToast]);

  // 自动检查：定时器 + 启动后延迟一次；disableUpdateCheck 翻转即整体停用。
  useEffect(() => {
    if (disableUpdateCheck) return;
    const timer = window.setInterval(
      () => void checkAppUpdate("auto"),
      AUTO_CHECK_INTERVAL_MS,
    );
    const startup = window.setTimeout(
      () => void checkAppUpdate("auto"),
      AUTO_CHECK_DELAY_MS,
    );
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(startup);
    };
  }, [checkAppUpdate, disableUpdateCheck]);

  const dismissAppUpdateInfo = useCallback(() => patchApp({ info: null }), [patchApp]);
  const dismissAppUpdateError = useCallback(() => patchApp({ error: null }), [patchApp]);
  const dismissUpToDate = useCallback(() => patchApp({ upToDateVersion: null }), [patchApp]);

  return {
    app,
    pi,
    checkAppUpdate,
    downloadAppUpdate,
    installDownloadedAppUpdate,
    ingestAppUpdateProgress,
    checkPiCliUpdateOnStartup,
    checkPiCliUpdate,
    updatePiCli,
    dismissAppUpdateInfo,
    dismissAppUpdateError,
    dismissUpToDate,
  };
}
