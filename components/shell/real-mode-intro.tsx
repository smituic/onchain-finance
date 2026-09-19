"use client";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * The one-time introduction shown before a user's first switch into Real
 * Mode. Its job is honesty, not onboarding: Real Mode is where real,
 * blockchain-backed money will eventually live, but today it is a
 * test-network build with nothing of value in it. Shown once — the mode
 * store remembers acknowledgement (see hasAcknowledgedRealIntro).
 */
export function RealModeIntro({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel();
      }}
    >
      <AlertDialogContent>
        <div className="flex flex-col gap-2">
          <AlertDialogTitle>Entering Real Mode</AlertDialogTitle>
          <AlertDialogDescription>
            Real Mode is where this app will eventually run on real, blockchain-backed money. Right now it&apos;s an
            early, development-only version that runs on a test network: test Cash has no value, and no real dollars
            are involved.
          </AlertDialogDescription>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Practice Mode stays exactly as it is, and you can switch back at any time.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Button size="lg" className="h-11 w-full" onClick={onConfirm}>
            Continue to Real Mode
          </Button>
          <Button variant="ghost" className="h-11 w-full" onClick={onCancel}>
            Stay in Practice
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
