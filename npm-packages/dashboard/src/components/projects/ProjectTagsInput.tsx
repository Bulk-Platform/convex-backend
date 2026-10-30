import {
  Combobox,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
  Label,
} from "@headlessui/react";
import { cn } from "@ui/cn";
import { ReactNode, useRef, useState } from "react";
import { Chip } from "@ui/Chip";
import { validateProjectTag } from "./projectTags";

/**
 * A list of project tags, each a removable pill, plus a text input that adds
 * the typed text as a tag once it passes the rules Big Brain checks tags
 * against.
 */
export function ProjectTagsInput({
  tags,
  onChange,
  label = "Tags",
  labelHidden = false,
  placeholder = "Add tags",
  description,
  disabled = false,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  label?: string;
  labelHidden?: boolean;
  placeholder?: string;
  /** Shown beneath the input while there's no error to show instead. */
  description?: ReactNode;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmedQuery = query.trim();

  const error =
    trimmedQuery === "" ? undefined : validateProjectTag(trimmedQuery, tags);
  const newTag =
    trimmedQuery !== "" && error === undefined ? trimmedQuery : undefined;

  const setTags = (newTags: string[]) => {
    onChange(newTags);
    setQuery("");
  };

  return (
    <Combobox
      multiple
      immediate
      value={tags}
      onChange={setTags}
      disabled={disabled}
    >
      {({ open, activeIndex }) => (
        <div className="flex w-full flex-col gap-1">
          <Label
            className={cn(
              "text-left text-sm text-content-primary",
              labelHidden && "sr-only",
            )}
          >
            {label}
          </Label>
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- The input is reachable from the keyboard on its own; this only widens its mouse target. */}
          <div
            onMouseDown={(event) => {
              // Once pills wrap, the input fills only the last row, so the
              // field's own padding and the space beside the pills focus it
              // too. Pills handle their own clicks.
              if (event.target === event.currentTarget && !disabled) {
                event.preventDefault();
                inputRef.current?.focus();
              }
            }}
            className={cn(
              "flex w-full cursor-text flex-wrap items-center gap-1.5 rounded-md border bg-background-secondary px-2 py-1.5 text-sm",
              error
                ? "focus-within:border-content-error"
                : "focus-within:border-border-selected",
              disabled &&
                "cursor-not-allowed bg-background-tertiary text-content-secondary",
            )}
          >
            {tags.map((tag) =>
              disabled ? (
                <Chip key={tag}>{tag}</Chip>
              ) : (
                <Chip
                  key={tag}
                  onRemove={() => setTags(tags.filter((t) => t !== tag))}
                  removeLabel={`Remove tag ${tag}`}
                  removeTip="Remove tag"
                >
                  {tag}
                </Chip>
              ),
            )}
            <ComboboxInput
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) {
                  return;
                }
                // Headless UI handles Enter on an active option. Otherwise
                // Enter adds the typed tag, or submits the surrounding form
                // if nothing is typed, which Headless UI blocks while open.
                if (event.key === "Enter" && !(open && activeIndex !== null)) {
                  event.preventDefault();
                  if (trimmedQuery === "") {
                    event.currentTarget.form?.requestSubmit();
                  } else if (newTag !== undefined) {
                    setTags([...tags, newTag]);
                  }
                }
                if (
                  event.key === "Backspace" &&
                  query === "" &&
                  tags.length > 0
                ) {
                  setTags(tags.slice(0, -1));
                }
              }}
              onBlur={() => {
                // Keep a typed tag the user didn't confirm with Enter, so
                // clicking Save right after typing doesn't drop it.
                if (newTag !== undefined) {
                  setTags([...tags, newTag]);
                }
              }}
              placeholder={tags.length === 0 ? placeholder : undefined}
              className="min-w-24 flex-1 bg-transparent p-0.5 placeholder-content-tertiary focus:outline-hidden disabled:cursor-not-allowed"
            />
          </div>
          {/* Rendered even when empty so the expanded combobox always has
              the listbox it points to. */}
          <ComboboxOptions
            anchor={{ to: "bottom start", gap: 4 }}
            modal={false}
            className="z-50 max-h-60 min-w-48 overflow-auto rounded-md border bg-background-secondary py-1 text-xs shadow-sm empty:invisible focus:outline-hidden"
          >
            {newTag !== undefined && (
              <ComboboxOption
                value={newTag}
                className="cursor-pointer px-2 py-1.5 text-content-primary select-none data-focus:bg-background-tertiary"
              >
                Add tag "{newTag}"
              </ComboboxOption>
            )}
          </ComboboxOptions>
          {error ? (
            <p
              className="animate-fadeInFromLoading text-xs text-content-errorSecondary"
              role="alert"
            >
              {error}
            </p>
          ) : (
            description && (
              <p className="max-w-prose text-xs text-content-secondary">
                {description}
              </p>
            )
          )}
        </div>
      )}
    </Combobox>
  );
}
