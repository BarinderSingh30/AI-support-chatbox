import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { AuthenticatedLayout } from './screens/AuthenticatedLayout.tsx';
import { SignIn } from './screens/SignIn.tsx';
import { Documents } from './screens/Documents.tsx';
import { Conversations } from './screens/Conversations.tsx';
import { ConversationDetail } from './screens/ConversationDetail.tsx';
import { Analytics } from './screens/Analytics.tsx';
import { WidgetConfigurator } from './screens/WidgetConfigurator.tsx';
import { WidgetKeys } from './screens/WidgetKeys.tsx';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/sign-in" element={<SignIn />} />
        <Route element={<AuthenticatedLayout />}>
          <Route index element={<Navigate to="/documents" replace />} />
          <Route path="documents" element={<Documents />} />
          <Route path="conversations" element={<Conversations />} />
          <Route path="conversations/:id" element={<ConversationDetail />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="widget" element={<WidgetConfigurator />} />
          <Route path="widget-keys" element={<WidgetKeys />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
