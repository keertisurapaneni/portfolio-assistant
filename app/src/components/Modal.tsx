import { type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../lib/utils';

interface ModalProps {
  /** Modal title displayed in the header */
  title: string;
  /** Callback when the modal is closed (backdrop click or X button) */
  onClose: () => void;
  /** Modal content */
  children: ReactNode;
  /** Width variant */
  size?: 'sm' | 'md' | 'lg';
  /** Optional className for the modal container */
  className?: string;
}

const sizeClasses = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
};

export function Modal({ title, onClose, children, size = 'md', className }: ModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div
        className={cn(
          'relative bg-white rounded-2xl shadow-2xl w-full overflow-hidden animate-fade-in-up max-h-[85vh] flex flex-col',
          sizeClasses[size],
          className,
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[hsl(var(--border))] flex-shrink-0">
          <h2 className="text-lg font-bold text-[hsl(var(--foreground))]">{title}</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-[hsl(var(--secondary))] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}
