import type { ReactNode } from 'react';

const Meta = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="api-meta">
    <span className="api-meta__label">{label}:</span>
    <span className="api-meta__value">{children}</span>
  </div>
);

export const Returns = ({ children }: { children: ReactNode }) => <Meta label="Returns">{children}</Meta>;

export const Errors = ({ children }: { children: ReactNode }) => <Meta label="Errors">{children}</Meta>;

export const Throws = ({ children }: { children: ReactNode }) => <Meta label="Throws">{children}</Meta>;

export const Type = ({ children }: { children: ReactNode }) => <Meta label="Type">{children}</Meta>;

export const Default = ({ children }: { children: ReactNode }) => <Meta label="Default">{children}</Meta>;

/** "(optional)" under a parameter or property name. */
export const Optional = () => <span className="optional">(optional)</span>;
