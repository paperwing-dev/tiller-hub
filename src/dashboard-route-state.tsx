import { Button } from '@cloudflare/kumo/components/button';
import LoadingIndicator from './LoadingIndicator';

export function RouteLoading({ label, fullScreen = false }: { label: string; fullScreen?: boolean }) {
  return (
    <LoadingIndicator
      label={label}
      size="lg"
      className={`${fullScreen ? 'h-screen' : 'min-h-0 flex-1'} bg-kumo-base`}
    />
  );
}

export function RouteLoadError({ label, onRetry }: { label: string; onRetry: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center bg-kumo-base px-4">
      <div className="max-w-sm border border-kumo-line bg-kumo-elevated p-4 text-center">
        <p className="text-sm font-semibold text-kumo-strong">{label}</p>
        <p className="mt-1 text-sm text-kumo-subtle">The dashboard data could not be loaded.</p>
        <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}

export function SetupStatusLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex h-screen items-center justify-center bg-kumo-base px-4">
      <div className="max-w-sm border border-kumo-line bg-kumo-elevated p-4 text-center">
        <p className="text-sm font-semibold text-kumo-strong">Setup status load failed</p>
        <p className="mt-1 text-sm text-kumo-subtle">{message}</p>
        <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}
