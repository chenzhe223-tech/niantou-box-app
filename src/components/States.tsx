import { Button } from './Button';
import { Icon } from './Icon';

export function LoadingState({ label = '正在打开念头盒…' }: { label?: string }) {
  return (
    <div className="nb-state" role="status">
      <span className="nb-spinner" aria-hidden="true" />
      <p className="nb-state__title">{label}</p>
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="nb-state nb-state--error" role="alert">
      <span className="nb-state__icon" aria-hidden="true">
        <Icon name="close" size={24} />
      </span>
      <p className="nb-state__title">本地数据读取失败</p>
      <p className="nb-state__message">{message}</p>
      {onRetry ? (
        <Button variant="secondary" icon="refresh" onClick={onRetry}>
          重试
        </Button>
      ) : null}
    </div>
  );
}
