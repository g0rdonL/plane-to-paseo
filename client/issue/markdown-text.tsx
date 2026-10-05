import type { PluginTheme } from "@getpaseo/plugin";
import { type ReactNode, useMemo } from "react";
import { Platform, Text, View } from "react-native";
import { replaceImageRefs } from "../../shared/plane-markdown";
import { openExternal } from "../web";

/**
 * A deliberately small Markdown renderer for Plane descriptions and comments. It covers what
 * people actually write in tickets: headings, lists, code, quotes, links, emphasis. Anything else
 * falls through as plain text. Images are replaced by placeholders; the image strip shows them.
 */

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; text: string; language: string | null }
  | { kind: "quote"; text: string }
  | { kind: "rule" };

export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) {
      blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
      paragraph.length = 0;
    }
  };

  while (i < lines.length) {
    const line = lines[i] as string;
    const fence = /^\s*```\s*(\w+)?\s*$/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] as string)) {
        code.push(lines[i] as string);
        i++;
      }
      i++;
      blocks.push({ kind: "code", text: code.join("\n"), language: fence[1] ?? null });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: (heading[1] as string).length,
        text: heading[2] ?? "",
      });
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] as string)) {
        quote.push((lines[i] as string).replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "quote", text: quote.join("\n") });
      continue;
    }
    const bullet = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      const ordered = /\d/.test(bullet[1] as string);
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i] as string;
        const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(current);
        if (item) {
          items.push(item[2] ?? "");
          i++;
        } else if (/^\s{2,}\S/.test(current) && items.length) {
          items[items.length - 1] = `${items[items.length - 1]}\n${current.trim()}`;
          i++;
        } else {
          break;
        }
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    if (line.trim() === "") {
      flush();
      i++;
      continue;
    }
    paragraph.push(line);
    i++;
  }
  flush();
  return blocks;
}

type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; url: string }
  | { kind: "placeholder"; text: string };

const INLINE_PATTERN =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\[[^\]\n]+\]\((?:https?:\/\/)[^)\s]+\))|(\[image:[^\]]*\])|((?<![\w*])\*[^*\n]+\*(?![\w*]))|((?<!\w)_[^_\n]+_(?!\w))|(https?:\/\/[^\s<>()]+)/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index;
    if (index > last) out.push({ kind: "text", text: text.slice(last, index) });
    const raw = match[0];
    if (match[1]) out.push({ kind: "code", text: raw.slice(1, -1) });
    else if (match[2] || match[3]) out.push({ kind: "bold", text: raw.slice(2, -2) });
    else if (match[4]) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(raw);
      out.push({ kind: "link", text: link?.[1] ?? raw, url: link?.[2] ?? "" });
    } else if (match[5]) out.push({ kind: "placeholder", text: raw });
    else if (match[6] || match[7]) out.push({ kind: "italic", text: raw.slice(1, -1) });
    else if (match[8]) out.push({ kind: "link", text: raw, url: raw });
    last = index + raw.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

const MONO = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "ui-monospace, Menlo, monospace",
});

function InlineText({
  theme,
  text,
  style,
}: {
  theme: PluginTheme;
  text: string;
  style?: { fontSize?: number; color?: string; fontWeight?: "400" | "600" | "700" };
}) {
  const parts = useMemo(() => parseInline(text), [text]);
  const base = {
    color: style?.color ?? theme.colors.foreground,
    fontSize: style?.fontSize ?? 14,
    lineHeight: (style?.fontSize ?? 14) * 1.5,
    fontWeight: style?.fontWeight ?? "400",
  } as const;
  return (
    <Text selectable style={base}>
      {parts.map((part, index) => {
        const key = `${index}-${part.kind}`;
        switch (part.kind) {
          case "bold":
            return (
              <Text key={key} style={{ fontWeight: "700" }}>
                {part.text}
              </Text>
            );
          case "italic":
            return (
              <Text key={key} style={{ fontStyle: "italic" }}>
                {part.text}
              </Text>
            );
          case "code":
            return (
              <Text
                key={key}
                style={{
                  fontFamily: MONO,
                  fontSize: base.fontSize - 1,
                  backgroundColor: theme.colors.surface2,
                  color: theme.colors.foreground,
                }}
              >
                {part.text}
              </Text>
            );
          case "link":
            return (
              <Text
                key={key}
                accessibilityRole="link"
                style={{ color: theme.colors.accent, textDecorationLine: "underline" }}
                onPress={() => void openExternal(part.url).catch(() => {})}
              >
                {part.text}
              </Text>
            );
          case "placeholder":
            return (
              <Text key={key} style={{ color: theme.colors.foregroundMuted, fontStyle: "italic" }}>
                {part.text}
              </Text>
            );
          default:
            return <Text key={key}>{part.text}</Text>;
        }
      })}
    </Text>
  );
}

export interface MarkdownTextProps {
  theme: PluginTheme;
  markdown: string;
  fontSize?: number;
}

export function MarkdownText({ theme, markdown, fontSize = 14 }: MarkdownTextProps) {
  const blocks = useMemo(
    () =>
      parseBlocks(replaceImageRefs(markdown, (ref) => `[image: ${ref.alt ?? "attached below"}]`)),
    [markdown],
  );
  const rendered: ReactNode[] = blocks.map((block, index) => {
    const key = `${index}-${block.kind}`;
    switch (block.kind) {
      case "heading": {
        const size =
          block.level <= 1 ? fontSize + 6 : block.level === 2 ? fontSize + 4 : fontSize + 2;
        return (
          <View key={key} style={{ marginTop: index === 0 ? 0 : 8 }}>
            <InlineText
              theme={theme}
              text={block.text}
              style={{ fontSize: size, fontWeight: "700" }}
            />
          </View>
        );
      }
      case "list":
        return (
          <View key={key} style={{ gap: 2 }}>
            {block.items.map((item, itemIndex) => (
              <View
                key={`${key}-${itemIndex}`}
                style={{ flexDirection: "row", gap: 8, paddingLeft: 4 }}
              >
                <Text
                  style={{
                    color: theme.colors.foregroundMuted,
                    fontSize,
                    lineHeight: fontSize * 1.5,
                    minWidth: 16,
                    textAlign: "right",
                  }}
                >
                  {block.ordered ? `${itemIndex + 1}.` : "•"}
                </Text>
                <View style={{ flex: 1 }}>
                  <InlineText
                    theme={theme}
                    text={item.replace(/^\[([ xX])\]\s*/, (_m, mark: string) =>
                      mark.trim() ? "☑ " : "☐ ",
                    )}
                    style={{ fontSize }}
                  />
                </View>
              </View>
            ))}
          </View>
        );
      case "code":
        return (
          <View
            key={key}
            style={{
              backgroundColor: theme.colors.surface2,
              borderRadius: 6,
              padding: 10,
              borderWidth: 1,
              borderColor: theme.colors.border,
            }}
          >
            <Text
              selectable
              style={{
                fontFamily: MONO,
                fontSize: fontSize - 1,
                color: theme.colors.foreground,
                lineHeight: (fontSize - 1) * 1.5,
              }}
            >
              {block.text}
            </Text>
          </View>
        );
      case "quote":
        return (
          <View
            key={key}
            style={{ borderLeftWidth: 3, borderLeftColor: theme.colors.border, paddingLeft: 10 }}
          >
            <InlineText
              theme={theme}
              text={block.text}
              style={{ fontSize, color: theme.colors.foregroundMuted }}
            />
          </View>
        );
      case "rule":
        return (
          <View
            key={key}
            style={{ height: 1, backgroundColor: theme.colors.border, marginVertical: 4 }}
          />
        );
      default:
        return <InlineText key={key} theme={theme} text={block.text} style={{ fontSize }} />;
    }
  });
  return <View style={{ gap: 8 }}>{rendered}</View>;
}
