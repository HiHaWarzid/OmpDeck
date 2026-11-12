/*
 * 启动画面诊断与兜底。
 *
 * 手机浏览器/弱网下，主模块脚本可能加载失败或长时间无响应，而启动遮罩
 * 由 index.html 静态渲染，用户只会看到“正在启动工作台…”永远不动。
 * 这里不依赖 React，先于主模块执行，负责：
 * - 捕获脚本加载失败、未捕获异常和未处理 Promise；
 * - 超时后给出明确文案和“重新加载”按钮；
 * - 不主动移除遮罩，避免和 React 的正常淡出逻辑竞争。
 */
(() => {
  const overlay = document.getElementById("boot-overlay");
  const subtitle = overlay?.querySelector(".boot-subtitle");
  if (!overlay || !subtitle) return;

  let reported = false;

  const showRetry = (message) => {
    subtitle.textContent = message;
    if (overlay.querySelector(".boot-retry")) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "boot-retry";
    button.textContent = "重新加载";
    button.addEventListener("click", () => window.location.reload());
    overlay.appendChild(button);
  };

  const report = (message) => {
    if (reported) return;
    reported = true;
    showRetry(message);
  };

  window.addEventListener(
    "error",
    (event) => {
      // 资源加载失败不会冒泡，必须用捕获阶段；脚本失败优先给出网络提示。
      const target = event.target;
      if (target instanceof HTMLScriptElement) {
        report("脚本加载失败，请检查网络后重试");
        return;
      }
      report(`启动失败：${event.message || "未知错误"}`);
    },
    true,
  );

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    report(`启动失败：${reason?.message || String(reason || "未知错误")}`);
  });

  // 30 秒仍未挂载完成：提示超时，避免用户误以为页面卡死。
  window.setTimeout(() => {
    if (!document.getElementById("boot-overlay")) return;
    report("加载超时，请检查网络后重试");
  }, 30_000);
})();
