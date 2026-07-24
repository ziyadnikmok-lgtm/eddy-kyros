import React from 'react';
import { cn } from '../../lib/utils';

function Input({ className, type = 'text', ...props }) {
  return (
    <input
      type={type}
      className={cn(
        'flex h-11 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white shadow-xs outline-none transition placeholder:text-zinc-500',
        'focus-visible:border-white/20 focus-visible:ring-2 focus-visible:ring-white/10',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  );
}

export { Input };
