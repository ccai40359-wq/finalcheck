from django.urls import path
from rest_framework.routers import DefaultRouter

from .views import EntryViewSet, ReportView, entry_export, me, monthly_total

router = DefaultRouter()
router.register("entries", EntryViewSet, basename="entry")

urlpatterns = [
    path("me/", me),
    path("reports/<int:pk>/", ReportView.as_view()),
    path("totals/", monthly_total),
    path("export/<int:pk>/", entry_export),
] + router.urls
