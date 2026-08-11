'use client';

import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '../../lib/utils';

const defaultStaggerTimes = {
  char: 0.03,
  word: 0.05,
  line: 0.1,
};

export function TextEffect({
  children,
  per = 'word',
  as = 'p',
  variants,
  className,
  delay = 0,
  trigger = true,
}) {
  const segments = per === 'line'
    ? children.split('\n')
    : per === 'word'
      ? children.split(/(\s+)/)
      : children.split('');

  const MotionTag = motion[as] || motion.p;
  const itemVariants = variants?.item || {
    hidden: { opacity: 0, filter: 'blur(10px)', y: 16 },
    visible: { opacity: 1, filter: 'blur(0px)', y: 0 },
    exit: { opacity: 0, filter: 'blur(10px)', y: 16 },
  };
  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        delayChildren: delay,
        staggerChildren: defaultStaggerTimes[per],
      },
    },
    exit: { opacity: 0 },
    ...(variants?.container || {}),
  };

  return (
    <AnimatePresence mode="popLayout">
      {trigger && (
        <MotionTag
          initial="hidden"
          animate="visible"
          exit="exit"
          variants={containerVariants}
          className={cn('whitespace-pre-wrap', className)}
        >
          {segments.map((segment, index) => (
            <motion.span
              key={`${per}-${index}-${segment}`}
              variants={itemVariants}
              className={per === 'line' ? 'block' : 'inline-block whitespace-pre'}
            >
              {segment}
            </motion.span>
          ))}
        </MotionTag>
      )}
    </AnimatePresence>
  );
}
