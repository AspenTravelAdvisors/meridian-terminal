import { X } from 'lucide-react';
import { Dialog as D, DropdownMenu as M, Switch as S, Tabs as T, Tooltip as Tip } from 'radix-ui';
import type { ReactNode } from 'react';

export function Modal({ open, onOpenChange, title, children, width = 560, footer, description }: { open: boolean; onOpenChange(o: boolean): void; title: ReactNode; children: ReactNode; width?: number; footer?: ReactNode; description?: string }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[1px]" />
        <D.Content
          className="fixed left-1/2 top-[8vh] z-50 flex max-h-[84vh] w-[calc(100vw-24px)] -translate-x-1/2 flex-col rounded-lg border border-border bg-panel text-text shadow-[var(--shadow)] focus:outline-none"
          style={{ maxWidth: width }}
          aria-describedby={description ? undefined : undefined}
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <D.Title className="text-[13px] font-semibold">{title}</D.Title>
            <D.Close className="icon-btn" aria-label="Close">
              <X className="size-4" />
            </D.Close>
          </div>
          <D.Description className="sr-only">{description ?? (typeof title === 'string' ? title : 'dialog')}</D.Description>
          <div className="min-h-0 flex-1 overflow-auto">{children}</div>
          {footer && <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function Tooltip({ content, children, side = 'bottom' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <Tip.Root delayDuration={350}>
      <Tip.Trigger asChild>{children}</Tip.Trigger>
      <Tip.Portal>
        <Tip.Content side={side} sideOffset={6} className="z-[60] max-w-xs rounded-md border border-border bg-raised px-2 py-1 text-[11px] text-text shadow-lg">
          {content}
        </Tip.Content>
      </Tip.Portal>
    </Tip.Root>
  );
}
export const TooltipProvider = Tip.Provider;

export function Menu({ trigger, children, align = 'start' }: { trigger: ReactNode; children: ReactNode; align?: 'start' | 'end' }) {
  return (
    <M.Root>
      <M.Trigger asChild>{trigger}</M.Trigger>
      <M.Portal>
        <M.Content align={align} sideOffset={4} className="z-[55] min-w-44 rounded-md border border-border bg-panel p-1 text-[12px] text-text shadow-[var(--shadow)]">
          {children}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}
export function MenuItem({ children, onSelect, active, disabled, hint }: { children: ReactNode; onSelect(): void; active?: boolean; disabled?: boolean; hint?: string }) {
  return (
    <M.Item disabled={disabled} onSelect={onSelect} className="flex cursor-default select-none items-center justify-between gap-4 rounded px-2 py-1.5 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-raised" data-active={active}>
      <span className={active ? 'text-accent' : ''}>{children}</span>
      {hint && <span className="kbd">{hint}</span>}
    </M.Item>
  );
}
export const MenuSep = () => <M.Separator className="my-1 h-px bg-border" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => <M.Label className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-faint">{children}</M.Label>;

export function Switch({ checked, onChange, label, id }: { checked: boolean; onChange(v: boolean): void; label?: string; id?: string }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2" htmlFor={id}>
      <S.Root id={id} checked={checked} onCheckedChange={onChange} className="relative h-4 w-7 rounded-full bg-border-strong transition-colors data-[state=checked]:bg-accent" aria-label={label}>
        <S.Thumb className="block size-3 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-3.5" />
      </S.Root>
      {label && <span className="text-[12px]">{label}</span>}
    </label>
  );
}

export function Tabs({ tabs, value, onChange, children }: { tabs: { id: string; label: ReactNode }[]; value: string; onChange(v: string): void; children: ReactNode }) {
  return (
    <T.Root value={value} onValueChange={onChange} className="flex h-full min-h-0 flex-col">
      <T.List className="flex shrink-0 gap-1 border-b border-border px-2">
        {tabs.map((t) => (
          <T.Trigger key={t.id} value={t.id} className="-mb-px border-b-2 border-transparent px-2.5 py-1.5 text-[12px] text-dim hover:text-text data-[state=active]:border-accent data-[state=active]:text-text">
            {t.label}
          </T.Trigger>
        ))}
      </T.List>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </T.Root>
  );
}
export const TabPanel = ({ value, children, className }: { value: string; children: ReactNode; className?: string }) => (
  <T.Content value={value} className={className ?? 'h-full'}>
    {children}
  </T.Content>
);

export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-faint">{hint}</span>}
    </label>
  );
}

export function Select<V extends string>({ value, onChange, options, className, label }: { value: V; onChange(v: V): void; options: { value: V; label: string }[]; className?: string; label?: string }) {
  return (
    <select className={`input ${className ?? ''}`} value={value} onChange={(e) => onChange(e.target.value as V)} aria-label={label}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-dim">
      {icon}
      <div className="text-[13px] font-medium text-text">{title}</div>
      {children && <div className="max-w-sm text-[12px]">{children}</div>}
    </div>
  );
}

export function Chip({ text, dir, strength = 0.5, onClick, title }: { text: string; dir: string; strength?: number; onClick?: () => void; title?: string }) {
  const color = dir === 'bull' ? 'var(--ok)' : dir === 'bear' ? 'var(--danger)' : 'var(--text-dim)';
  const bg = `color-mix(in srgb, ${color} ${Math.round(12 + strength * 22)}%, transparent)`;
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag className="chip" style={{ color, background: bg }} onClick={onClick} title={title}>
      {text}
    </Tag>
  );
}
