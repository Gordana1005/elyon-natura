import { Navigate } from 'react-router-dom';

/** "Повторни повици · Мои" lives inside /calls since plan Фаза 11. */
export const CALL_AGAIN_VIEW_PATH = '/calls?queue=call-again';

/** /call-again (bookmarks, old notification links) → the callbacks view of /calls. */
export function CallAgainRedirect() {
  return <Navigate to={CALL_AGAIN_VIEW_PATH} replace />;
}
