import React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '../../lib/utils';

function Label({ className, ...props }) {
  return (
    <LabelPrimitive.Root
      className={cn('text-sm font-medium text-zinc-200', className)}
      {...props}
    />
  );
}

export { Label };
