/**
 * Icon utilities for rendering Ant Design icons by name
 *
 * This module provides a curated set of ~100 icons for plugin developers.
 * All icons are tree-shaken properly and only included if used.
 */

import * as React from 'react';

// Import curated icon set for plugin developers
import {
  // Navigation & Layout
  HomeOutlined,
  DashboardOutlined,
  MenuOutlined,
  AppstoreOutlined,
  LayoutOutlined,
  SettingOutlined,
  UnorderedListOutlined,
  OrderedListOutlined,

  // Actions & Controls
  PlayCircleOutlined,
  PauseCircleOutlined,
  StopOutlined,
  ReloadOutlined,
  SyncOutlined,
  PlusOutlined,
  MinusOutlined,
  CloseOutlined,
  CheckOutlined,
  EditOutlined,
  DeleteOutlined,
  SaveOutlined,
  DownloadOutlined,
  UploadOutlined,
  ExportOutlined,
  ImportOutlined,
  CopyOutlined,
  SearchOutlined,
  FilterOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
  PaperClipOutlined,

  // Status & Alerts
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
  WarningOutlined,
  QuestionCircleOutlined,
  LoadingOutlined,
  SyncOutlined as SpinOutlined,

  // Files & Folders
  FileOutlined,
  FileTextOutlined,
  FileImageOutlined,
  FilePdfOutlined,
  FileWordOutlined,
  FileExcelOutlined,
  FolderOutlined,
  FolderOpenOutlined,

  // Development & Code
  CodeOutlined,
  BugOutlined,
  ApiOutlined,
  ConsoleSqlOutlined,
  FunctionOutlined,
  DeploymentUnitOutlined,
  BranchesOutlined,
  NodeIndexOutlined,

  // Git & Version Control
  GithubOutlined,
  GitlabOutlined,
  PullRequestOutlined,
  MergeCellsOutlined,

  // Data & Analytics
  DatabaseOutlined,
  TableOutlined,
  BarChartOutlined,
  LineChartOutlined,
  PieChartOutlined,
  AreaChartOutlined,
  DotChartOutlined,

  // Communication
  MailOutlined,
  MessageOutlined,
  CommentOutlined,
  NotificationOutlined,
  BellOutlined,

  // Users & Teams
  UserOutlined,
  TeamOutlined,
  UsergroupAddOutlined,
  ContactsOutlined,

  // Time & Calendar
  ClockCircleOutlined,
  CalendarOutlined,
  HistoryOutlined,
  FieldTimeOutlined,

  // Media & Visual
  PictureOutlined,
  CameraOutlined,
  VideoCameraOutlined,
  EyeOutlined,
  EyeInvisibleOutlined,

  // Network & Cloud
  CloudOutlined,
  CloudDownloadOutlined,
  CloudUploadOutlined,
  GlobalOutlined,
  WifiOutlined,
  ApiOutlined as LinkOutlined,

  // Security
  LockOutlined,
  UnlockOutlined,
  SafetyOutlined,
  SafetyCertificateOutlined,
  KeyOutlined,

  // Tools & Utilities
  ToolOutlined,
  BuildOutlined,
  ExperimentOutlined,
  RocketOutlined,
  RobotOutlined,
  ThunderboltOutlined,
  FireOutlined,
  BulbOutlined,

  // Misc
  StarOutlined,
  HeartOutlined,
  TrophyOutlined,
  GiftOutlined,
  AimOutlined,
  FlagOutlined,
  TagOutlined,
  BookOutlined,
  MoreOutlined,
  EllipsisOutlined,
  RightOutlined,
  LeftOutlined,
  UpOutlined,
  DownOutlined,
} from '@ant-design/icons';

/**
 * Registry of all available icons for plugin developers.
 * This is the complete list of icons that can be used in plugin manifests.
 */
export const AVAILABLE_ICONS: Record<string, React.ComponentType<any>> = {
  // Navigation & Layout
  HomeOutlined,
  DashboardOutlined,
  MenuOutlined,
  AppstoreOutlined,
  LayoutOutlined,
  SettingOutlined,
  UnorderedListOutlined,
  OrderedListOutlined,

  // Actions & Controls
  PlayCircleOutlined,
  PauseCircleOutlined,
  StopOutlined,
  ReloadOutlined,
  SyncOutlined,
  PlusOutlined,
  MinusOutlined,
  CloseOutlined,
  CheckOutlined,
  EditOutlined,
  DeleteOutlined,
  SaveOutlined,
  DownloadOutlined,
  UploadOutlined,
  ExportOutlined,
  ImportOutlined,
  CopyOutlined,
  SearchOutlined,
  FilterOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
  PaperClipOutlined,

  // Status & Alerts
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
  WarningOutlined,
  QuestionCircleOutlined,
  LoadingOutlined,
  SpinOutlined,

  // Files & Folders
  FileOutlined,
  FileTextOutlined,
  FileImageOutlined,
  FilePdfOutlined,
  FileWordOutlined,
  FileExcelOutlined,
  FolderOutlined,
  FolderOpenOutlined,

  // Development & Code
  CodeOutlined,
  BugOutlined,
  ApiOutlined,
  ConsoleSqlOutlined,
  FunctionOutlined,
  DeploymentUnitOutlined,
  BranchesOutlined,
  NodeIndexOutlined,

  // Git & Version Control
  GithubOutlined,
  GitlabOutlined,
  PullRequestOutlined,
  MergeCellsOutlined,

  // Data & Analytics
  DatabaseOutlined,
  TableOutlined,
  BarChartOutlined,
  LineChartOutlined,
  PieChartOutlined,
  AreaChartOutlined,
  DotChartOutlined,

  // Communication
  MailOutlined,
  MessageOutlined,
  CommentOutlined,
  NotificationOutlined,
  BellOutlined,

  // Users & Teams
  UserOutlined,
  TeamOutlined,
  UsergroupAddOutlined,
  ContactsOutlined,

  // Time & Calendar
  ClockCircleOutlined,
  CalendarOutlined,
  HistoryOutlined,
  FieldTimeOutlined,

  // Media & Visual
  PictureOutlined,
  CameraOutlined,
  VideoCameraOutlined,
  EyeOutlined,
  EyeInvisibleOutlined,

  // Network & Cloud
  CloudOutlined,
  CloudDownloadOutlined,
  CloudUploadOutlined,
  GlobalOutlined,
  WifiOutlined,
  LinkOutlined,

  // Security
  LockOutlined,
  UnlockOutlined,
  SafetyOutlined,
  SafetyCertificateOutlined,
  KeyOutlined,

  // Tools & Utilities
  ToolOutlined,
  BuildOutlined,
  ExperimentOutlined,
  RocketOutlined,
  RobotOutlined,
  ThunderboltOutlined,
  FireOutlined,
  BulbOutlined,

  // Misc
  StarOutlined,
  HeartOutlined,
  TrophyOutlined,
  GiftOutlined,
  AimOutlined,
  FlagOutlined,
  TagOutlined,
  BookOutlined,
  MoreOutlined,
  EllipsisOutlined,
  RightOutlined,
  LeftOutlined,
  UpOutlined,
  DownOutlined,
};

/**
 * Get icon component by name.
 * Only icons from AVAILABLE_ICONS registry are supported.
 *
 * @param iconName - Icon name from the available icons list
 * @returns Icon component or null if not found
 *
 * @example
 * ```tsx
 * const IconComponent = getIconComponent('HomeOutlined');
 * if (IconComponent) {
 *   return <IconComponent />;
 * }
 * ```
 */
export function getIconComponent(iconName?: string): React.ComponentType<any> | null {
  if (!iconName) {return null;}

  const icon = AVAILABLE_ICONS[iconName];
  if (!icon) {
    console.warn(`Icon "${iconName}" is not available. Check AVAILABLE_ICONS registry.`);
    return null;
  }

  return icon;
}

/**
 * Render icon by name.
 *
 * @param iconName - Icon name from the available icons list
 * @param props - Icon props (style, className, etc.)
 * @returns Rendered icon element or null if not found
 *
 * @example
 * ```tsx
 * // Simple usage
 * {renderIcon('HomeOutlined')}
 *
 * // With props
 * {renderIcon('SettingOutlined', { style: { fontSize: 20 } })}
 * ```
 */
export function renderIcon(iconName?: string, props?: any): React.ReactElement | null {
  const IconComponent = getIconComponent(iconName);
  if (!IconComponent) {return null;}
  return <IconComponent {...props} />;
}

/**
 * Get list of all available icon names.
 * Useful for documentation and validation.
 */
export function getAvailableIconNames(): string[] {
  return Object.keys(AVAILABLE_ICONS).sort();
}

// Re-export all icons for direct import
export {
  // Navigation & Layout
  HomeOutlined,
  DashboardOutlined,
  MenuOutlined,
  AppstoreOutlined,
  LayoutOutlined,
  SettingOutlined,
  UnorderedListOutlined,
  OrderedListOutlined,

  // Actions & Controls
  PlayCircleOutlined,
  PauseCircleOutlined,
  StopOutlined,
  ReloadOutlined,
  SyncOutlined,
  PlusOutlined,
  MinusOutlined,
  CloseOutlined,
  CheckOutlined,
  EditOutlined,
  DeleteOutlined,
  SaveOutlined,
  DownloadOutlined,
  UploadOutlined,
  ExportOutlined,
  ImportOutlined,
  CopyOutlined,
  SearchOutlined,
  FilterOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
  PaperClipOutlined,

  // Status & Alerts
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
  WarningOutlined,
  QuestionCircleOutlined,
  LoadingOutlined,

  // Files & Folders
  FileOutlined,
  FileTextOutlined,
  FileImageOutlined,
  FilePdfOutlined,
  FileWordOutlined,
  FileExcelOutlined,
  FolderOutlined,
  FolderOpenOutlined,

  // Development & Code
  CodeOutlined,
  BugOutlined,
  ApiOutlined,
  ConsoleSqlOutlined,
  FunctionOutlined,
  DeploymentUnitOutlined,
  BranchesOutlined,

  // Git & Version Control
  GithubOutlined,
  GitlabOutlined,
  PullRequestOutlined,
  MergeCellsOutlined,

  // Data & Analytics
  DatabaseOutlined,
  TableOutlined,
  BarChartOutlined,
  LineChartOutlined,
  PieChartOutlined,
  AreaChartOutlined,
  DotChartOutlined,

  // Communication
  MailOutlined,
  MessageOutlined,
  CommentOutlined,
  NotificationOutlined,
  BellOutlined,

  // Users & Teams
  UserOutlined,
  TeamOutlined,
  UsergroupAddOutlined,
  ContactsOutlined,

  // Time & Calendar
  ClockCircleOutlined,
  CalendarOutlined,
  HistoryOutlined,
  FieldTimeOutlined,

  // Media & Visual
  PictureOutlined,
  CameraOutlined,
  VideoCameraOutlined,
  EyeOutlined,
  EyeInvisibleOutlined,

  // Network & Cloud
  CloudOutlined,
  CloudDownloadOutlined,
  CloudUploadOutlined,
  GlobalOutlined,
  WifiOutlined,

  // Security
  LockOutlined,
  UnlockOutlined,
  SafetyOutlined,
  SafetyCertificateOutlined,
  KeyOutlined,

  // Tools & Utilities
  ToolOutlined,
  BuildOutlined,
  ExperimentOutlined,
  RocketOutlined,
  RobotOutlined,
  ThunderboltOutlined,
  FireOutlined,
  BulbOutlined,

  // Misc
  StarOutlined,
  HeartOutlined,
  TrophyOutlined,
  GiftOutlined,
  AimOutlined,
  FlagOutlined,
  TagOutlined,
  BookOutlined,
};
