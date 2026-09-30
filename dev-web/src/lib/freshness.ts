/**
 * How long a copy the loader has just fetched is served without asking again.
 *
 * For data another person may change, and whose writes quote the version on
 * screen: a pipeline draft, a cycle, an officer's file, the applicant's own
 * application. These were `staleTime: 0` so that no screen would act on an old
 * version — but zero also refetched every one of them the moment its component
 * mounted, milliseconds after the route loader had fetched it, as a second
 * request the screen waited for (docs/rules/frontend.md).
 *
 * A few seconds is still current for what the guard protects: a write built on
 * a version that changed meanwhile is refused by the server and says so, which
 * is the same outcome zero gave. After that the query refreshes as before, and
 * every mutation still invalidates what it changed.
 */
export const JUST_LOADED = 5_000
