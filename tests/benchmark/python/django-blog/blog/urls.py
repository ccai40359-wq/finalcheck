from django.urls import path

from . import views

urlpatterns = [
    path("posts/", views.post_list, name="post_list"),
    path("posts/<int:pk>/", views.post_detail, name="post_detail"),
    path("posts/<int:pk>/edit/", views.post_edit, name="post_edit"),
    path("posts/<int:pk>/edit-safe/", views.post_edit_safe, name="post_edit_safe"),
    path("posts/<int:pk>/delete/", views.PostDeleteView.as_view(), name="post_delete"),
    path("drafts/", views.DraftListView.as_view(), name="drafts"),
    path("search/", views.search, name="search"),
    path("search-safe/", views.search_safe, name="search_safe"),
    path("export/", views.export_all, name="export"),
    path("webhook/", views.payment_webhook, name="webhook"),
    path("preview/", views.preview, name="preview"),
]
