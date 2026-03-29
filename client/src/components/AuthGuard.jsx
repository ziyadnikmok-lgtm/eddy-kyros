import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function AuthGuard({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div style={{display:'flex',justifyContent:'center',alignItems:'center',height:'100vh'}}>Loading...</div>;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}
