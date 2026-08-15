import { useState, type ReactNode } from 'react';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';

/**
 * Cloudscape replacement for native `window.confirm()`.
 *
 * Native confirm() is jarring on macOS / mobile, blocks the JS event loop,
 * and can't be dismissed via the SPA's keyboard / focus state. The
 * Cloudscape Modal feels like the rest of the app and is keyboard- /
 * screen-reader-friendly.
 *
 * Usage:
 *
 *   const confirmDelete = useConfirm();
 *   ...
 *   const ok = await confirmDelete({
 *     title: 'Delete budget',
 *     body: <>Delete budget for <code>{p}</code> on <code>{t}</code>?</>,
 *     confirmLabel: 'Delete',
 *     destructive: true,
 *   });
 *   if (!ok) return;
 *
 * The component-level dialog renders below the trigger; parents must mount
 * the returned `<ConfirmDialog />` element exactly once in their JSX tree.
 */
export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

interface PendingState extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export const useConfirm = (): {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  dialog: ReactNode;
} => {
  const [pending, setPending] = useState<PendingState | undefined>();

  const confirm = (opts: ConfirmOptions) =>
    new Promise<boolean>((resolve) => setPending({ ...opts, resolve }));

  const close = (ok: boolean) => {
    if (pending) {
      pending.resolve(ok);
      setPending(undefined);
    }
  };

  const dialog = pending ? (
    <Modal
      visible
      onDismiss={() => close(false)}
      header={pending.title}
      footer={
        <Box float="right">
          <SpaceBetween size="xs" direction="horizontal">
            <Button variant="link" onClick={() => close(false)}>
              {pending.cancelLabel ?? 'Cancel'}
            </Button>
            <Button
              variant={pending.destructive ? 'primary' : 'normal'}
              onClick={() => close(true)}
            >
              {pending.confirmLabel ?? 'Confirm'}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      {pending.body}
    </Modal>
  ) : null;

  return { confirm, dialog };
};
