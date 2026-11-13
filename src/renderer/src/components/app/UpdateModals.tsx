import { t } from "../../i18n";
import { ModalSurface } from "../ui/ModalSurface";
import { Button } from "../ui/Button";

export function UpdateErrorModal(props: {
  message: string;
  releasesUrl: string;
  onClose: () => void;
  onOpenRelease: () => void;
}) {
  return (
    <ModalSurface
      open
      onRequestClose={props.onClose}
      size="small"
      title={t("update.checkFailedTitle")}
      className="update-modal update-error-modal"
    >
      <div className="update-body">
        <p className="update-version-line">
          {t("update.checkFailedDescription")}
        </p>
        <div className="update-error-detail">
          {t("update.errorInfo", { message: props.message })}
        </div>
        <p className="update-asset-line">
          {t("update.manualReleaseHint")}
          <br />
          <span>{props.releasesUrl}</span>
        </p>
      </div>
      <div className="update-actions">
        <Button variant="secondary" onClick={props.onClose}>{t("common.close")}</Button>
        <Button variant="primary" onClick={props.onOpenRelease}>
          {t("update.openReleasePage")}
        </Button>
      </div>
    </ModalSurface>
  );
}

export function UpToDateModal(props: {
  version: string;
  releasesUrl: string;
  onClose: () => void;
  onOpenRelease: () => void;
}) {
  return (
    <ModalSurface
      open
      onRequestClose={props.onClose}
      size="small"
      title={t("update.upToDateTitle")}
      className="update-modal update-uptodate-modal"
    >
      <div className="update-body">
        <p className="update-version-line">
          {t("update.upToDateMessage", { version: props.version })}
        </p>
      </div>
      <div className="update-actions">
        <Button variant="secondary" onClick={props.onClose}>{t("common.close")}</Button>
        <Button variant="secondary" onClick={props.onOpenRelease}>
          {t("update.openReleasePage")}
        </Button>
      </div>
    </ModalSurface>
  );
}
