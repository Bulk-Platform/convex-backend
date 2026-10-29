import { cn } from "@ui/cn";

// Projects have at most 5 tags (see `big_brain_lib::model::project_tags`), so
// every tag renders on one line that scrolls horizontally when it overflows.
//
// The edge fade is a fixed mask over 1rem of padding on each side: at rest the
// padding sits under the fade, so it only shows once tags scroll beneath it.
// `-mx-4` bleeds that padding into the surrounding 1rem of card padding or
// column gap, keeping the first tag aligned with the content above it.
//
// The list is raised above a card's overlay link so it receives wheel and
// touch scrolling; `w-fit` keeps the empty space beside the tags clickable, and
// `select-none` keeps a drag across the row from selecting tag text.
export function ProjectTags({
  tags,
  chipClassName,
}: {
  tags: string[];
  chipClassName?: string;
}) {
  if (tags.length === 0) {
    return null;
  }

  return (
    <ul
      aria-label="Tags"
      className="relative z-10 -mx-4 scrollbar-none flex w-fit max-w-[calc(100%+2rem)] min-w-0 gap-1 overflow-x-auto mask-[linear-gradient(to_right,transparent,black_1rem,black_calc(100%-1rem),transparent)] px-4 select-none focus-visible:mask-none"
      // The tags hold no controls, so the row itself takes focus to be
      // scrollable from the keyboard; the fade lifts so the focus ring shows.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- https://dequeuniversity.com/rules/axe/4.11/scrollable-region-focusable?application=axeAPI
      tabIndex={0}
    >
      {tags.map((tag) => (
        <li
          key={tag}
          className={cn(
            "h-5 shrink-0 rounded-sm bg-background-tertiary px-1.5 text-xs/5 whitespace-nowrap text-content-primary",
            chipClassName,
          )}
        >
          {tag}
        </li>
      ))}
    </ul>
  );
}
