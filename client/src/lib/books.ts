export function bookLabel(book: { readonly book_id: string; readonly variant: string }): string {
  return book.variant === 'primary' ? book.book_id : `↳ ${book.variant} (shadow)`;
}
