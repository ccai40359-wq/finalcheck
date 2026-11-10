// 时间线工具图标（内联 SVG，stroke 继承 currentColor；不用 emoji）
const base = (props) => ({
  width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
  ...props
});

export function IconTerminal(props) {
  return <svg {...base(props)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3" /><path d="M13 15h4" /></svg>;
}
export function IconEdit(props) {
  return <svg {...base(props)}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>;
}
export function IconFile(props) {
  return <svg {...base(props)}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="M8 13h8M8 17h5" /></svg>;
}
export function IconBrain(props) {
  return (
    <svg {...base(props)}>
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M12 5v13" />
    </svg>
  );
}
export function IconBook(props) {
  return <svg {...base(props)}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" /></svg>;
}
export function IconList(props) {
  return <svg {...base(props)}><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></svg>;
}
export function IconShield(props) {
  return <svg {...base(props)}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>;
}
export function IconSearch(props) {
  return <svg {...base(props)}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>;
}
export function IconZap(props) {
  return <svg {...base(props)}><path d="M13 2 3 14h8l-1 8 10-12h-8l1-8z" /></svg>;
}
export function IconDownload(props) {
  return <svg {...base(props)}><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></svg>;
}
export function IconTool(props) {
  return <svg {...base(props)}><path d="M14.7 6.3a4 4 0 0 0 5 5l-9.4 9.4a2.8 2.8 0 0 1-4-4Z" /><path d="m15 5 4 4" /></svg>;
}
// 技能（魔法棒 + 星点）：read_playbook / list_playbooks 用
export function IconSkill(props) {
  return (
    <svg {...base(props)}>
      <path d="M14.5 6.5 4 17" /><path d="M17.5 3.5l1.2 2.3 2.3 1.2-2.3 1.2L17.5 10.5l-1.2-2.3L14 7l2.3-1.2Z" />
      <path d="M8 21l.6-1.4L10 19l-1.4-.6L8 17l-.6 1.4L6 19l1.4.6Z" />
    </svg>
  );
}

export function iconFor(kind) {
  switch (kind) {
    case 'terminal': return IconTerminal;
    case 'edit': return IconEdit;
    case 'file': return IconFile;
    case 'book': return IconBook;
    case 'list': return IconList;
    case 'shield': return IconShield;
    case 'search': return IconSearch;
    case 'stress': return IconZap;
    case 'download': return IconDownload;
    case 'skill': return IconSkill;
    default: return IconTool;
  }
}
