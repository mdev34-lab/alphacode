import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-logo-mark-shadow" d="M12 16H4V8H12V16Z" fill="var(--icon-weak-base)" />
      <path data-slot="logo-logo-mark-o" d="M12 4H4V16H12V4ZM16 20H0V0H16V20Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M60 80H20V40H60V80Z" fill="var(--icon-base)" />
      <path d="M60 20H20V80H60V20ZM80 100H0V0H80V100Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 246 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g>
        <rect x="30" y="0" width="6" height="36" fill="var(--icon-base)" />
        <rect x="72" y="0" width="6" height="36" fill="var(--icon-base)" />
        <rect x="210" y="0" width="6" height="36" fill="var(--icon-strong-base)" />
        <rect x="6" y="6" width="18" height="6" fill="var(--icon-base)" />
        <rect x="42" y="6" width="24" height="6" fill="var(--icon-base)" />
        <rect x="78" y="6" width="12" height="6" fill="var(--icon-base)" />
        <rect x="108" y="6" width="18" height="6" fill="var(--icon-base)" />
        <rect x="132" y="6" width="24" height="6" fill="var(--icon-strong-base)" />
        <rect x="162" y="6" width="24" height="6" fill="var(--icon-strong-base)" />
        <rect x="192" y="6" width="18" height="6" fill="var(--icon-strong-base)" />
        <rect x="222" y="6" width="24" height="6" fill="var(--icon-strong-base)" />
        <rect x="18" y="12" width="6" height="24" fill="var(--icon-base)" />
        <rect x="42" y="12" width="6" height="30" fill="var(--icon-base)" />
        <rect x="60" y="12" width="6" height="24" fill="var(--icon-base)" />
        <rect x="90" y="12" width="6" height="24" fill="var(--icon-base)" />
        <rect x="120" y="12" width="6" height="24" fill="var(--icon-base)" />
        <rect x="132" y="12" width="6" height="24" fill="var(--icon-strong-base)" />
        <rect x="162" y="12" width="6" height="24" fill="var(--icon-strong-base)" />
        <rect x="180" y="12" width="6" height="24" fill="var(--icon-strong-base)" />
        <rect x="192" y="12" width="6" height="24" fill="var(--icon-strong-base)" />
        <rect x="222" y="12" width="6" height="24" fill="var(--icon-strong-base)" />
        <rect x="240" y="12" width="6" height="12" fill="var(--icon-strong-base)" />
        <rect x="0" y="18" width="18" height="6" fill="var(--icon-base)" />
        <rect x="48" y="18" width="12" height="12" fill="var(--icon-weak-base)" />
        <rect x="78" y="18" width="12" height="18" fill="var(--icon-weak-base)" />
        <rect x="102" y="18" width="18" height="6" fill="var(--icon-base)" />
        <rect x="138" y="18" width="18" height="12" fill="var(--icon-weak-base)" />
        <rect x="168" y="18" width="12" height="12" fill="var(--icon-weak-base)" />
        <rect x="198" y="18" width="12" height="12" fill="var(--icon-weak-base)" />
        <rect x="228" y="18" width="12" height="6" fill="var(--icon-strong-base)" />
        <rect x="0" y="24" width="6" height="12" fill="var(--icon-base)" />
        <rect x="6" y="24" width="12" height="6" fill="var(--icon-weak-base)" />
        <rect x="102" y="24" width="6" height="12" fill="var(--icon-base)" />
        <rect x="108" y="24" width="12" height="6" fill="var(--icon-weak-base)" />
        <rect x="228" y="24" width="18" height="6" fill="var(--icon-weak-base)" />
        <rect x="6" y="30" width="12" height="6" fill="var(--icon-base)" />
        <rect x="48" y="30" width="12" height="6" fill="var(--icon-base)" />
        <rect x="108" y="30" width="12" height="6" fill="var(--icon-base)" />
        <rect x="138" y="30" width="18" height="6" fill="var(--icon-strong-base)" />
        <rect x="168" y="30" width="12" height="6" fill="var(--icon-strong-base)" />
        <rect x="198" y="30" width="12" height="6" fill="var(--icon-strong-base)" />
        <rect x="228" y="30" width="18" height="6" fill="var(--icon-strong-base)" />
      </g>
    </svg>
  )
}
