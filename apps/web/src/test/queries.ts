import { within } from "@testing-library/react"

/** The text an element shows, its pieces separated by single spaces. */
export const textOf = (element: Element): string => {
  const pieces: Array<string> = []
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent?.trim()
    if (text) pieces.push(text)
  }
  return pieces.join(" ")
}

/** Each body row of `table` as { column header: cell text }. */
export const rowsOf = (table: HTMLElement) => {
  const [head, ...body] = within(table).getAllByRole("row")
  const headers = within(head!)
    .getAllByRole("columnheader")
    .map((th) => th.getAttribute("aria-label") ?? textOf(th))
  return body.map((row) =>
    Object.fromEntries(
      within(row)
        .getAllByRole("cell")
        .map((cell, index) => [headers[index], textOf(cell)]),
    ),
  )
}

/** Each body row of `table` as { column header: cell text }, row headers included. */
export const tableOf = (table: HTMLElement) => {
  const [head, ...body] = within(table).getAllByRole("row")
  const headers = [...(head?.children ?? [])].map(
    (th) => th.getAttribute("aria-label") ?? textOf(th),
  )
  return body.map((row) =>
    Object.fromEntries([...row.children].map((cell, index) => [headers[index], textOf(cell)])),
  )
}
