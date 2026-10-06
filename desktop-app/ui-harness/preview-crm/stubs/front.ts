// THROWAWAY STUB of twenty-sdk/front-component for local screenshots only.
const q = new URLSearchParams(location.search);
export const useColorScheme = () => (q.get('theme') === 'dark' ? 'dark' : 'light');
export const AppPath = { PageLayoutPage: 'PageLayoutPage' };
export const navigate = async (path: string, params: unknown) => {
  console.log('navigate', path, JSON.stringify(params));
  (window as unknown as { __nav?: unknown[] }).__nav = [...((window as unknown as { __nav?: unknown[] }).__nav ?? []), params];
};
export const copyToClipboard = async (_t: string) => {};
export const enqueueSnackbar = async (_o: unknown) => {};
