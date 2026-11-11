// Marketing's path links for posts on X: /x/{slug}/ sends the reader on to the target page with
// utm_source=x&utm_content={slug}, so a signup or trial from the post is credited to it. GitHub Pages can't send
// a 302, so each is a static copy of the target's page (its own title and preview card, for X's crawler) that
// replaces the location at once. Add a line here for a new post.
export const X_LINKS = {
  kahn: 'investors/irving-kahn/',
  season: 'season/',
}
