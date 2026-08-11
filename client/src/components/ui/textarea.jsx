import React from 'react';
import { cn } from '../../lib/utils';

function Textarea({ className, ...props }) {
  return (
    <textarea
      className={cn(
        'flex min-h-28 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white shadow-xs outline-none transition placeholder:text-zinc-500',
        'focus-visible:border-white/20 focus-visible:ring-2 focus-visible:ring-white/10',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
