import { describe, expect, it } from "vitest";
import {
  assetApiUrl,
  decodeEntities,
  extractAssetIds,
  extractImageRefs,
  htmlToMarkdown,
  replaceImageRefs,
} from "./plane-markdown";

describe("htmlToMarkdown", () => {
  it("returns an empty string for empty input", () => {
    expect(htmlToMarkdown(null)).toBe("");
    expect(htmlToMarkdown("<p></p>")).toBe("");
  });

  it("converts paragraphs, headings, and inline marks", () => {
    const html =
      '<h2>Goal</h2><p>Ship <strong>fast</strong>, <em>safely</em> and <s>never</s> <code>rm -rf</code>.</p><p class="editor-paragraph-block">Second&nbsp;line &amp; more</p>';
    expect(htmlToMarkdown(html)).toBe(
      "## Goal\n\nShip **fast**, _safely_ and ~~never~~ `rm -rf`.\n\nSecond line & more",
    );
  });

  it("converts nested lists and task lists", () => {
    const html = [
      "<ul><li><p>One</p><ul><li><p>One.a</p></li></ul></li><li><p>Two</p></li></ul>",
      '<ol start="3"><li><p>Three</p></li><li><p>Four</p></li></ol>',
      '<ul data-type="taskList"><li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked></label><div><p>Done</p></div></li><li data-checked="false" data-type="taskItem"><label><input type="checkbox"></label><div><p>Todo</p></div></li></ul>',
    ].join("");
    expect(htmlToMarkdown(html)).toBe(
      [
        "- One",
        "  - One.a",
        "- Two",
        "",
        "3. Three",
        "4. Four",
        "",
        "- [x] Done",
        "- [ ] Todo",
      ].join("\n"),
    );
  });

  it("keeps code blocks verbatim with their language", () => {
    const html =
      '<pre><code class="language-ts">const a = 1;\nif (a &lt; 2) {\n  go();\n}</code></pre>';
    expect(htmlToMarkdown(html)).toBe("```ts\nconst a = 1;\nif (a < 2) {\n  go();\n}\n```");
  });

  it("converts blockquotes, links, and rules", () => {
    const html =
      '<blockquote><p>Quoted</p><p>Twice</p></blockquote><hr><p>See <a href="https://plane.so/x">the docs</a> and <a href="https://a.b/c">https://a.b/c</a>.</p>';
    expect(htmlToMarkdown(html)).toBe(
      "> Quoted\n>\n> Twice\n\n---\n\nSee [the docs](https://plane.so/x) and <https://a.b/c>.",
    );
  });

  it("drops javascript links but keeps their text", () => {
    expect(htmlToMarkdown('<p><a href="javascript:alert(1)">click</a></p>')).toBe("click");
  });

  it("drops scripts, styles, and comments entirely", () => {
    const html =
      "<p>Safe</p><script>alert('x')</script><style>p{color:red}</style><!-- note --><p>Also safe</p>";
    expect(htmlToMarkdown(html)).toBe("Safe\n\nAlso safe");
  });

  it("resolves image-component asset ids and keeps absolute images", () => {
    const html =
      '<p>Before</p><image-component src="0b7c4e2a-1111-2222-3333-444455556666" width="35px" height="auto" id="x" aspectratio="1"></image-component><p><img src="https://example.com/a.png" alt="ext"></p>';
    const markdown = htmlToMarkdown(html, {
      resolveAsset: (id) => `https://plane.example/api/v1/workspaces/w/assets/${id}/`,
    });
    expect(markdown).toBe(
      "Before\n\n![](https://plane.example/api/v1/workspaces/w/assets/0b7c4e2a-1111-2222-3333-444455556666/)\n\n![ext](https://example.com/a.png)",
    );
  });

  it("leaves a placeholder when an asset cannot be resolved", () => {
    expect(htmlToMarkdown('<image-component src="abc"></image-component>')).toBe("[image]");
  });

  it("renders user mentions by name", () => {
    const html =
      '<p>Ping <mention-component entity_identifier="u1" entity_name="user_mention"></mention-component> and <mention-component entity_identifier="u2"></mention-component></p>';
    expect(htmlToMarkdown(html, { resolveMention: (id) => (id === "u1" ? "Ada" : null) })).toBe(
      "Ping @Ada and @someone",
    );
  });

  it("converts tables", () => {
    const html =
      "<table><tbody><tr><th><p>Name</p></th><th><p>Value</p></th></tr><tr><td><p>a|b</p></td><td><p>1</p></td></tr></tbody></table>";
    expect(htmlToMarkdown(html)).toBe("| Name | Value |\n| --- | --- |\n| a\\|b | 1 |");
  });

  it("tolerates unclosed and stray tags", () => {
    expect(htmlToMarkdown("<p>open <strong>bold</p></span><p>next")).toBe("open **bold**\n\nnext");
  });
});

describe("decodeEntities", () => {
  it("decodes named and numeric entities and leaves unknown ones", () => {
    expect(decodeEntities("&lt;a&gt; &#39;x&#39; &#x1F600; &bogus;")).toBe("<a> 'x' 😀 &bogus;");
  });
});

describe("extractAssetIds", () => {
  it("lists image-component asset ids in order, de-duplicated", () => {
    const html =
      '<image-component src="a1"></image-component><p>x</p><image-component src="b2" /><image-component src="a1"></image-component><image-component src="https://x.y/z.png"></image-component>';
    expect(extractAssetIds(html)).toEqual(["a1", "b2"]);
  });
});

describe("extractImageRefs", () => {
  it("finds markdown and html images in order, de-duplicated, http only", () => {
    const markdown = [
      "Intro ![First shot](https://plane.example/a/1.png) text",
      '![](https://plane.example/a/2.png "title")',
      '<img src="https://example.com/3.jpg" width="100">',
      "![again](https://plane.example/a/1.png)",
      "![local](file:///tmp/x.png)",
      "![angle](<https://plane.example/a/4.png>)",
    ].join("\n");
    expect(extractImageRefs(markdown)).toEqual([
      { url: "https://plane.example/a/1.png", alt: "First shot" },
      { url: "https://plane.example/a/2.png", alt: null },
      { url: "https://example.com/3.jpg", alt: null },
      { url: "https://plane.example/a/4.png", alt: "angle" },
    ]);
  });

  it("returns nothing for empty input", () => {
    expect(extractImageRefs(null)).toEqual([]);
    expect(extractImageRefs("")).toEqual([]);
  });
});

describe("replaceImageRefs", () => {
  it("replaces http images and leaves others", () => {
    const markdown = "a ![x](https://h/1.png) b ![y](file:///z.png)";
    expect(replaceImageRefs(markdown, (ref) => `[${ref.alt}]`)).toBe("a [x] b ![y](file:///z.png)");
  });
});

describe("assetApiUrl", () => {
  it("builds the v1 asset endpoint", () => {
    expect(assetApiUrl("https://plane.aight.to/", "aight", "a1")).toBe(
      "https://plane.aight.to/api/v1/workspaces/aight/assets/a1/",
    );
  });
});
