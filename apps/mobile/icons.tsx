import React from "react";
import Svg, { Circle, Ellipse, Path, Rect } from "react-native-svg";

/**
 * The composer icons, drawn with react-native-svg using lucide's exact geometry — the same
 * icons the web app uses (lucide-react), without depending on lucide-react-native (whose
 * barrel import of ~2800 modules failed to evaluate under JSC and black-screened the app).
 */
type IconProps = { size?: number; color?: string; strokeWidth?: number; fill?: string };

function Base({ size = 24, color = "#000", strokeWidth = 2, fill = "none", children }: IconProps & { children: React.ReactNode }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </Svg>
  );
}

export const ImageIcon = (p: IconProps) => (
  <Base {...p}>
    <Rect width={18} height={18} x={3} y={3} rx={2} ry={2} />
    <Circle cx={9} cy={9} r={2} />
    <Path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
  </Base>
);

export const Camera = (p: IconProps) => (
  <Base {...p}>
    <Path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" />
    <Circle cx={12} cy={13} r={3} />
  </Base>
);

export const Mic = (p: IconProps) => (
  <Base {...p}>
    <Path d="M12 19v3" />
    <Path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <Rect x={9} y={2} width={6} height={13} rx={3} />
  </Base>
);

export const Square = (p: IconProps) => (
  <Base {...p}>
    <Rect width={18} height={18} x={3} y={3} rx={2} />
  </Base>
);

export const Paperclip = (p: IconProps) => (
  <Base {...p}>
    <Path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551" />
  </Base>
);

export const ArrowUp = (p: IconProps) => (
  <Base {...p}>
    <Path d="m5 12 7-7 7 7" />
    <Path d="M12 19V5" />
  </Base>
);

export const Plus = (p: IconProps) => (
  <Base {...p}>
    <Path d="M5 12h14" />
    <Path d="M12 5v14" />
  </Base>
);

export const X = (p: IconProps) => (
  <Base {...p}>
    <Path d="M18 6 6 18" />
    <Path d="m6 6 12 12" />
  </Base>
);

export const FileUp = (p: IconProps) => (
  <Base {...p}>
    <Path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
    <Path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <Path d="M12 12v6" />
    <Path d="m15 15-3-3-3 3" />
  </Base>
);

export const Phone = (p: IconProps) => (
  <Base {...p}>
    <Path d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384" />
  </Base>
);

export const Settings = (p: IconProps) => (
  <Base {...p}>
    <Path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <Circle cx={12} cy={12} r={3} />
  </Base>
);

export const RotateCcw = (p: IconProps) => (
  <Base {...p}>
    <Path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <Path d="M3 3v5h5" />
  </Base>
);

export const Menu = (p: IconProps) => (
  <Base {...p}>
    <Path d="M4 5h16" />
    <Path d="M4 12h16" />
    <Path d="M4 19h16" />
  </Base>
);

export const Trash = (p: IconProps) => (
  <Base {...p}>
    <Path d="M3 6h18" />
    <Path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <Path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </Base>
);

/* ── Left-rail nav icons — the web LeashRail geometry (apps/web/components/LeashRail.tsx),
 *    viewBox 0 0 24 24, drawn for strokeWidth 1.7. ─────────────────────────────────── */

export const Home = (p: IconProps) => (
  <Base {...p}>
    <Path d="M4 10.5 12 4l8 6.5" />
    <Path d="M6 9.5V20h12V9.5" />
  </Base>
);

export const ChatBubble = (p: IconProps) => (
  <Base {...p}>
    <Path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" />
  </Base>
);

export const Newspaper = (p: IconProps) => (
  <Base {...p}>
    <Path d="M4 4h13v15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
    <Path d="M17 8h3v10a2 2 0 0 1-2 2" />
    <Path d="M7 8h7M7 11.5h7M7 15h4" />
  </Base>
);

export const Brain = (p: IconProps) => (
  <Base {...p}>
    <Path d="M12 4.5a3 3 0 0 0-3-1.5 3 3 0 0 0-2.6 3.4A3.2 3.2 0 0 0 4 9.5a3.2 3.2 0 0 0 1 5.7A3 3 0 0 0 8 19a3 3 0 0 0 4 .9V4.5z" />
    <Path d="M12 4.5a3 3 0 0 1 3-1.5 3 3 0 0 1 2.6 3.4A3.2 3.2 0 0 1 20 9.5a3.2 3.2 0 0 1-1 5.7A3 3 0 0 1 16 19a3 3 0 0 1-4 .9" />
  </Base>
);

export const ListChecks = (p: IconProps) => (
  <Base {...p}>
    <Path d="m3.5 6 1.5 1.5L8 4.5M3.5 12.5 5 14l3-3M3.5 19l1.5 1.5 3-3" />
    <Path d="M11.5 6.5H21M11.5 13H21M11.5 19.5H21" />
  </Base>
);

export const Bell = (p: IconProps) => (
  <Base {...p}>
    <Path d="M18 8.5a6 6 0 1 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 14.5 18 8.5z" />
    <Path d="M10.3 20a2 2 0 0 0 3.4 0" />
  </Base>
);

export const Database = (p: IconProps) => (
  <Base {...p}>
    <Ellipse cx={12} cy={6} rx={7} ry={2.5} />
    <Path d="M5 6v5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6" />
    <Path d="M5 11v5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-5" />
  </Base>
);

export const MeshNodes = (p: IconProps) => (
  <Base {...p}>
    <Circle cx={12} cy={12} r={2.4} />
    <Circle cx={5} cy={5.5} r={1.9} />
    <Circle cx={19} cy={5.5} r={1.9} />
    <Circle cx={5} cy={18.5} r={1.9} />
    <Circle cx={19} cy={18.5} r={1.9} />
    <Path d="M10.3 10.4 6.3 6.8M13.7 10.4l4-3.6M10.3 13.6l-4 3.6M13.7 13.6l4 3.6" />
  </Base>
);

export const Services = (p: IconProps) => (
  <Base {...p}>
    <Circle cx={12} cy={12} r={3.2} />
    <Path d="M12 3.5v2.6M12 17.9v2.6M3.5 12h2.6M17.9 12h2.6M6 6l1.9 1.9M16.1 16.1 18 18M18 6l-1.9 1.9M7.9 16.1 6 18" />
  </Base>
);
